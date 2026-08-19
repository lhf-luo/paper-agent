import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalArtifactUrl } from "./artifact-discovery.ts";
import {
	type ArtifactGoldAnnotation,
	type ArtifactGoldEntry,
	validateArtifactGoldAnnotation,
} from "./artifact-evaluation.ts";
import type { CommandExecutor } from "./command-executor.ts";
import type { ArtifactCandidate } from "./literature-types.ts";
import type {
	ConfirmationGrant,
	OperationConsentManager,
	OperationPlan,
	PreparedOperation,
} from "./operation-consent.ts";

export interface ArtifactEvaluationSource {
	slug: string;
	title: string;
	paperId?: string;
	pdfPath: string;
	pdfSha256?: string;
	sourceUrl: string;
	status: "available" | "pending-download";
	tags?: string[];
}

export interface ArtifactCandidateReviewInput {
	candidateId: string;
	disposition: "expected" | "ignored";
	artifactId?: string;
	kind?: ArtifactCandidate["kind"];
	acceptedUrls?: string[];
	pages?: number[];
	note?: string;
	reason?: string;
}

export interface ArtifactReviewSubmissionInput {
	reviewer: string;
	reviewedAt: string;
	reviewedPages: number[];
	notes?: string;
	candidateReviews: ArtifactCandidateReviewInput[];
	manualArtifacts?: ArtifactGoldEntry[];
}

export interface ArtifactCandidateReviewState {
	candidateId: string;
	disposition: "pending" | "expected" | "ignored";
	artifactId?: string;
	kind?: ArtifactCandidate["kind"];
	acceptedUrls?: string[];
	pages?: number[];
	note?: string;
	reason?: string;
}

export interface ArtifactReviewQueueItem {
	slug: string;
	title: string;
	paperId?: string;
	tags: string[];
	sourceStatus: ArtifactEvaluationSource["status"];
	pdfAvailable: boolean;
	candidateCount: number;
	humanReviewed: boolean;
	pageCount?: number;
	reviewedPageCount: number;
	expectedArtifactCount: number;
	ignoredUrlCount: number;
	reviewer?: string;
	reviewedAt?: string;
	issues: string[];
}

export interface ArtifactReviewDetail {
	queue: ArtifactReviewQueueItem;
	source: ArtifactEvaluationSource;
	pdfSha256: string;
	pdfBytes: number;
	pageCount: number;
	candidates: ArtifactCandidate[];
	annotation?: ArtifactGoldAnnotation;
	reviewState: {
		reviewer: string;
		reviewedAt?: string;
		notes: string;
		reviewedPages: number[];
		candidateReviews: ArtifactCandidateReviewState[];
		manualArtifacts: ArtifactGoldEntry[];
	};
}

export class ArtifactReviewNotFoundError extends Error {}

interface ArtifactEvaluationReviewServiceOptions {
	projectRoot: string;
	dataRoot: string;
	executor: CommandExecutor;
	consent: OperationConsentManager;
	artifactRoot?: string;
}

const artifactKinds = new Set<ArtifactCandidate["kind"]>(["repository", "dataset", "supplement", "project", "unknown"]);

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, maximum: number, required = false): string | undefined {
	if (value === undefined || value === null) {
		if (required) throw new Error(`${label} is required`);
		return undefined;
	}
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const normalized = value.trim();
	if (required && !normalized) throw new Error(`${label} is required`);
	if (normalized.length > maximum) throw new Error(`${label} is too long`);
	return normalized || undefined;
}

function pageList(value: unknown, label: string, pageCount: number): number[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	const pages = [...new Set(value.map((page) => Number(page)))].sort((left, right) => left - right);
	if (pages.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) {
		throw new Error(`${label} contains a page outside the pinned PDF`);
	}
	return pages;
}

function stringList(value: unknown, label: string, maximumItems: number, maximumLength: number): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} must be a bounded string array`);
	const strings = value.map((item) => {
		if (typeof item !== "string" || !item.trim() || item.trim().length > maximumLength) {
			throw new Error(`${label} contains an invalid string`);
		}
		return item.trim();
	});
	return [...new Set(strings)];
}

function safeArtifactId(value: unknown, label: string): string {
	const id = boundedText(value, label, 200, true) as string;
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
		throw new Error(`${label} must use letters, numbers, dots, underscores, colons, or hyphens`);
	}
	return id;
}

export class ArtifactEvaluationReviewService {
	readonly artifactRoot: string;
	readonly annotationRoot: string;
	readonly candidateRoot: string;
	readonly pdfRoot: string;
	private readonly sourcePath: string;
	private readonly executor: CommandExecutor;
	private readonly consent: OperationConsentManager;

	constructor(options: ArtifactEvaluationReviewServiceOptions) {
		const projectRoot = resolve(options.projectRoot);
		this.artifactRoot = resolve(options.artifactRoot ?? join(projectRoot, "eval-data", "artifacts"));
		this.annotationRoot = join(this.artifactRoot, "annotations");
		this.candidateRoot = join(this.artifactRoot, "candidates");
		this.pdfRoot = resolve(projectRoot, "eval-data", "pdfs");
		this.sourcePath = join(this.artifactRoot, "sources.json");
		this.executor = options.executor;
		this.consent = options.consent;
	}

	private validateSource(value: unknown): ArtifactEvaluationSource {
		const source = plainObject(value, "Artifact evaluation source");
		const slug = boundedText(source.slug, "source.slug", 128, true) as string;
		if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(slug)) throw new Error("source.slug is unsafe");
		const title = boundedText(source.title, "source.title", 1_000, true) as string;
		const paperId = boundedText(source.paperId, "source.paperId", 500);
		const pdfPath = boundedText(source.pdfPath, "source.pdfPath", 2_000, true) as string;
		const pdfSha256 = boundedText(source.pdfSha256, "source.pdfSha256", 64);
		if (pdfSha256 && !/^[a-f0-9]{64}$/i.test(pdfSha256)) throw new Error(`${slug}: source PDF SHA-256 is invalid`);
		const sourceUrl = boundedText(source.sourceUrl, "source.sourceUrl", 2_000, true) as string;
		const url = new URL(sourceUrl);
		if (url.protocol !== "https:") throw new Error(`${slug}: sourceUrl must use HTTPS`);
		if (source.status !== "available" && source.status !== "pending-download") {
			throw new Error(`${slug}: source.status is invalid`);
		}
		return {
			slug,
			title,
			paperId,
			pdfPath,
			pdfSha256: pdfSha256?.toLowerCase(),
			sourceUrl,
			status: source.status,
			tags: stringList(source.tags, "source.tags", 50, 100),
		};
	}

	private async sources(): Promise<ArtifactEvaluationSource[]> {
		const parsed = JSON.parse(await readFile(this.sourcePath, "utf8")) as unknown;
		if (!Array.isArray(parsed)) throw new Error("Artifact evaluation sources.json must contain an array");
		const sources = parsed.map((value) => this.validateSource(value));
		const slugs = new Set<string>();
		for (const source of sources) {
			if (slugs.has(source.slug)) throw new Error(`Duplicate artifact evaluation slug: ${source.slug}`);
			slugs.add(source.slug);
		}
		return sources;
	}

	private async source(slug: string): Promise<ArtifactEvaluationSource> {
		if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(slug))
			throw new ArtifactReviewNotFoundError("Unknown artifact evaluation paper");
		const source = (await this.sources()).find((candidate) => candidate.slug === slug);
		if (!source) throw new ArtifactReviewNotFoundError(`Unknown artifact evaluation paper: ${slug}`);
		return source;
	}

	private pdfPath(source: ArtifactEvaluationSource): string {
		const path = resolve(this.artifactRoot, source.pdfPath);
		const pathRelative = relative(this.pdfRoot, path);
		if (
			!pathRelative ||
			pathRelative.startsWith("..") ||
			isAbsolute(pathRelative) ||
			!path.toLowerCase().endsWith(".pdf")
		) {
			throw new Error(`${source.slug}: pdfPath must resolve to one PDF under eval-data/pdfs`);
		}
		return path;
	}

	private async verifiedPdf(
		source: ArtifactEvaluationSource,
	): Promise<{ path: string; body: Buffer; pdfSha256: string }> {
		if (source.status !== "available" || !source.pdfSha256) {
			throw new Error(`${source.slug}: PDF is not available and hash-pinned`);
		}
		const path = this.pdfPath(source);
		const body = await readFile(path);
		if (!body.subarray(0, 5).equals(Buffer.from("%PDF-")))
			throw new Error(`${source.slug}: pinned file is not a PDF`);
		const actual = sha256(body);
		if (actual !== source.pdfSha256) throw new Error(`${source.slug}: pinned PDF SHA-256 changed`);
		return { path, body, pdfSha256: actual };
	}

	private async pageCount(pdfPath: string, slug: string): Promise<number> {
		const result = await this.executor.exec("pdfinfo", [pdfPath], { timeout: 30_000 });
		if (result.code !== 0 || result.killed) throw new Error(`${slug}: ${result.stderr.trim() || "pdfinfo failed"}`);
		const pageCount = Number(/^Pages:\s+(\d+)\s*$/im.exec(result.stdout)?.[1]);
		if (!Number.isInteger(pageCount) || pageCount < 1)
			throw new Error(`${slug}: pdfinfo did not report a page count`);
		return pageCount;
	}

	private async candidateSnapshot(source: ArtifactEvaluationSource): Promise<ArtifactGoldAnnotation> {
		const snapshot = JSON.parse(
			await readFile(join(this.candidateRoot, `${source.slug}.json`), "utf8"),
		) as ArtifactGoldAnnotation;
		validateArtifactGoldAnnotation(snapshot);
		if (snapshot.annotationStatus !== "machine-generated-candidate") {
			throw new Error(`${source.slug}: candidate snapshot must remain machine-generated-candidate`);
		}
		if (snapshot.source.slug !== source.slug || snapshot.source.pdfSha256 !== source.pdfSha256) {
			throw new Error(`${source.slug}: candidate snapshot does not match sources.json`);
		}
		const ids = new Set<string>();
		for (const candidate of snapshot.detectorCandidates ?? []) {
			if (!candidate.id || ids.has(candidate.id))
				throw new Error(`${source.slug}: detector candidate ids must be unique`);
			ids.add(candidate.id);
		}
		return snapshot;
	}

	private async existingAnnotation(
		source: ArtifactEvaluationSource,
	): Promise<{ annotation?: ArtifactGoldAnnotation; hash?: string }> {
		try {
			const body = await readFile(join(this.annotationRoot, `${source.slug}.json`));
			const annotation = JSON.parse(body.toString("utf8")) as ArtifactGoldAnnotation;
			validateArtifactGoldAnnotation(annotation);
			if (annotation.source.slug !== source.slug || annotation.source.pdfSha256 !== source.pdfSha256) {
				throw new Error(`${source.slug}: reviewed annotation does not match sources.json`);
			}
			return { annotation, hash: sha256(body) };
		} catch (error) {
			if (isMissing(error)) return {};
			throw error;
		}
	}

	private reviewState(
		candidates: ArtifactCandidate[],
		annotation?: ArtifactGoldAnnotation,
	): ArtifactReviewDetail["reviewState"] {
		const expectedByUrl = new Map<string, ArtifactGoldEntry>();
		const ignoredByUrl = new Map<string, { url: string; reason: string }>();
		for (const expected of annotation?.expectedArtifacts ?? []) {
			for (const url of expected.urls) expectedByUrl.set(canonicalArtifactUrl(url), expected);
		}
		for (const ignored of annotation?.ignoredUrls ?? []) ignoredByUrl.set(canonicalArtifactUrl(ignored.url), ignored);
		const candidateUrls = new Set(candidates.map((candidate) => canonicalArtifactUrl(candidate.url)));
		const candidateReviews: ArtifactCandidateReviewState[] = candidates.map((candidate) => {
			const canonical = canonicalArtifactUrl(candidate.url);
			const expected = expectedByUrl.get(canonical);
			if (expected) {
				return {
					candidateId: candidate.id,
					disposition: "expected",
					artifactId: expected.id,
					kind: expected.kind ?? candidate.kind,
					acceptedUrls: expected.urls,
					pages: expected.pages,
					note: expected.note,
				};
			}
			const ignored = ignoredByUrl.get(canonical);
			if (ignored) return { candidateId: candidate.id, disposition: "ignored", reason: ignored.reason };
			return { candidateId: candidate.id, disposition: "pending" };
		});
		const manualArtifacts = (annotation?.expectedArtifacts ?? []).filter((entry) =>
			entry.urls.every((url) => !candidateUrls.has(canonicalArtifactUrl(url))),
		);
		return {
			reviewer: annotation?.inspection.reviewer ?? "",
			reviewedAt: annotation?.inspection.reviewedAt,
			notes: annotation?.inspection.notes ?? "",
			reviewedPages: annotation?.inspection.reviewedPages ?? [],
			candidateReviews,
			manualArtifacts,
		};
	}

	private queueItem(
		source: ArtifactEvaluationSource,
		candidateCount: number,
		pdfAvailable: boolean,
		annotation: ArtifactGoldAnnotation | undefined,
		issues: string[],
	): ArtifactReviewQueueItem {
		return {
			slug: source.slug,
			title: source.title,
			paperId: source.paperId,
			tags: source.tags ?? [],
			sourceStatus: source.status,
			pdfAvailable,
			candidateCount,
			humanReviewed: annotation?.annotationStatus === "human-reviewed",
			pageCount: annotation?.inspection.pageCount,
			reviewedPageCount: annotation?.inspection.reviewedPages?.length ?? 0,
			expectedArtifactCount: annotation?.expectedArtifacts.length ?? 0,
			ignoredUrlCount: annotation?.ignoredUrls.length ?? 0,
			reviewer: annotation?.inspection.reviewer,
			reviewedAt: annotation?.inspection.reviewedAt,
			issues,
		};
	}

	async list(): Promise<{ papers: ArtifactReviewQueueItem[]; totals: Record<string, number> }> {
		const sources = await this.sources();
		const papers = await Promise.all(
			sources.map(async (source) => {
				const issues: string[] = [];
				let pdfAvailable = false;
				let candidateCount = 0;
				let annotation: ArtifactGoldAnnotation | undefined;
				try {
					pdfAvailable = (await stat(this.pdfPath(source))).isFile();
				} catch (error) {
					issues.push(
						isMissing(error) ? "Pinned PDF is missing" : error instanceof Error ? error.message : String(error),
					);
				}
				try {
					candidateCount = (await this.candidateSnapshot(source)).detectorCandidates?.length ?? 0;
				} catch (error) {
					issues.push(`Candidate snapshot: ${error instanceof Error ? error.message : String(error)}`);
				}
				try {
					annotation = (await this.existingAnnotation(source)).annotation;
				} catch (error) {
					issues.push(`Reviewed annotation: ${error instanceof Error ? error.message : String(error)}`);
				}
				return this.queueItem(source, candidateCount, pdfAvailable, annotation, issues);
			}),
		);
		papers.sort(
			(left, right) =>
				Number(left.humanReviewed) - Number(right.humanReviewed) || left.title.localeCompare(right.title),
		);
		return {
			papers,
			totals: {
				papers: papers.length,
				humanReviewed: papers.filter((paper) => paper.humanReviewed).length,
				pending: papers.filter((paper) => !paper.humanReviewed).length,
				candidates: papers.reduce((sum, paper) => sum + paper.candidateCount, 0),
				expectedArtifacts: papers.reduce((sum, paper) => sum + paper.expectedArtifactCount, 0),
				issues: papers.filter((paper) => paper.issues.length > 0).length,
			},
		};
	}

	async detail(slug: string): Promise<ArtifactReviewDetail> {
		const source = await this.source(slug);
		const [{ path, body, pdfSha256 }, snapshot, existing] = await Promise.all([
			this.verifiedPdf(source),
			this.candidateSnapshot(source),
			this.existingAnnotation(source),
		]);
		const pageCount = await this.pageCount(path, slug);
		const candidates = snapshot.detectorCandidates ?? [];
		return {
			queue: {
				...this.queueItem(source, candidates.length, true, existing.annotation, []),
				pageCount,
			},
			source,
			pdfSha256,
			pdfBytes: body.length,
			pageCount,
			candidates,
			annotation: existing.annotation,
			reviewState: this.reviewState(candidates, existing.annotation),
		};
	}

	async readPdf(slug: string): Promise<{ body: Buffer; filename: string }> {
		const source = await this.source(slug);
		const verified = await this.verifiedPdf(source);
		return { body: verified.body, filename: verified.path.split(/[\\/]/).at(-1) ?? `${source.slug}.pdf` };
	}

	private normalizeSubmission(detail: ArtifactReviewDetail, input: unknown): ArtifactGoldAnnotation {
		const submission = plainObject(input, "Artifact review submission");
		const reviewer = boundedText(submission.reviewer, "reviewer", 200, true) as string;
		const reviewedAt = boundedText(submission.reviewedAt, "reviewedAt", 100, true) as string;
		if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error("reviewedAt must be a valid timestamp");
		const notes = boundedText(submission.notes, "notes", 20_000);
		const reviewedPages = pageList(submission.reviewedPages, "reviewedPages", detail.pageCount);
		if (reviewedPages.length !== detail.pageCount || reviewedPages.some((page, index) => page !== index + 1)) {
			throw new Error("Every physical PDF page must be explicitly reviewed before gold can be saved");
		}
		if (!Array.isArray(submission.candidateReviews)) throw new Error("candidateReviews must be an array");
		if (submission.candidateReviews.length !== detail.candidates.length) {
			throw new Error("Every detector candidate must be classified as expected or ignored");
		}

		const candidates = new Map(detail.candidates.map((candidate) => [candidate.id, candidate]));
		const seenCandidateIds = new Set<string>();
		const expected = new Map<string, { entry: ArtifactGoldEntry; urls: Map<string, string>; pages: Set<number> }>();
		const ignored = new Map<string, { url: string; reason: string }>();
		const urlDecisions = new Map<string, string>();

		for (const rawReview of submission.candidateReviews) {
			const review = plainObject(rawReview, "candidate review");
			const candidateId = boundedText(review.candidateId, "candidateId", 200, true) as string;
			if (seenCandidateIds.has(candidateId)) throw new Error("Each detector candidate may be classified only once");
			seenCandidateIds.add(candidateId);
			const candidate = candidates.get(candidateId);
			if (!candidate) throw new Error(`Unknown detector candidate: ${candidateId}`);
			const canonicalCandidate = canonicalArtifactUrl(candidate.url);
			if (review.disposition === "ignored") {
				const reason = boundedText(review.reason, "ignored reason", 10_000, true) as string;
				const previous = urlDecisions.get(canonicalCandidate);
				if (previous && previous !== "ignored")
					throw new Error("The same canonical URL cannot be expected and ignored");
				urlDecisions.set(canonicalCandidate, "ignored");
				const existing = ignored.get(canonicalCandidate);
				if (existing && existing.reason !== reason)
					throw new Error("Duplicate ignored URL has conflicting reasons");
				ignored.set(canonicalCandidate, { url: candidate.url, reason });
				continue;
			}
			if (review.disposition !== "expected")
				throw new Error("Every candidate disposition must be expected or ignored");
			const artifactId = safeArtifactId(review.artifactId, "artifactId");
			const kindValue = review.kind ?? candidate.kind;
			if (typeof kindValue !== "string" || !artifactKinds.has(kindValue as ArtifactCandidate["kind"])) {
				throw new Error("Artifact kind is invalid");
			}
			const kind = kindValue as ArtifactCandidate["kind"];
			const pages = review.pages === undefined ? [] : pageList(review.pages, "artifact pages", detail.pageCount);
			const note = boundedText(review.note, "artifact note", 10_000);
			const acceptedUrls = new Map<string, string>();
			for (const url of [candidate.url, ...stringList(review.acceptedUrls, "acceptedUrls", 20, 2_000)]) {
				acceptedUrls.set(canonicalArtifactUrl(url), url);
			}
			for (const canonical of acceptedUrls.keys()) {
				const previousDecision = urlDecisions.get(canonical);
				if (previousDecision && previousDecision !== artifactId) {
					throw new Error("The same canonical URL cannot belong to two artifact decisions");
				}
			}
			for (const canonical of acceptedUrls.keys()) urlDecisions.set(canonical, artifactId);
			let group = expected.get(artifactId);
			if (!group) {
				const created = {
					entry: { id: artifactId, urls: [], kind, note },
					urls: new Map<string, string>(),
					pages: new Set<number>(),
				};
				expected.set(artifactId, created);
				group = created;
			} else {
				if (group.entry.kind && group.entry.kind !== kind)
					throw new Error("Grouped artifact candidates have conflicting kinds");
				if (group.entry.note && note && group.entry.note !== note)
					throw new Error("Grouped artifact candidates have conflicting notes");
				group.entry.note ??= note;
			}
			for (const [canonical, url] of acceptedUrls) group.urls.set(canonical, url);
			for (const page of pages) group.pages.add(page);
		}
		if (seenCandidateIds.size !== candidates.size) throw new Error("Every detector candidate must be classified");

		const candidateUrls = new Set(detail.candidates.map((candidate) => canonicalArtifactUrl(candidate.url)));
		const manualArtifacts = submission.manualArtifacts === undefined ? [] : submission.manualArtifacts;
		if (!Array.isArray(manualArtifacts) || manualArtifacts.length > 200) {
			throw new Error("manualArtifacts must be a bounded array");
		}
		for (const rawArtifact of manualArtifacts) {
			const artifact = plainObject(rawArtifact, "manual artifact");
			const id = safeArtifactId(artifact.id, "manual artifact id");
			if (expected.has(id)) throw new Error("Manual artifact id duplicates a detector-backed artifact id");
			const urls = new Map<string, string>();
			for (const url of stringList(artifact.urls, "manual artifact urls", 20, 2_000)) {
				urls.set(canonicalArtifactUrl(url), url);
			}
			if (!urls.size) throw new Error("Manual artifacts require at least one accepted URL");
			for (const canonical of urls.keys()) {
				if (candidateUrls.has(canonical)) {
					throw new Error(
						"A detector URL must be classified in candidateReviews instead of added as a manual artifact",
					);
				}
				const previousDecision = urlDecisions.get(canonical);
				if (previousDecision && previousDecision !== id) {
					throw new Error("The same canonical URL cannot belong to two artifact decisions");
				}
			}
			for (const canonical of urls.keys()) urlDecisions.set(canonical, id);
			const kind = artifact.kind as ArtifactCandidate["kind"] | undefined;
			if (kind !== undefined && !artifactKinds.has(kind)) throw new Error("Manual artifact kind is invalid");
			const pages =
				artifact.pages === undefined
					? undefined
					: pageList(artifact.pages, "manual artifact pages", detail.pageCount);
			expected.set(id, {
				entry: {
					id,
					urls: [...urls.values()],
					kind,
					pages: pages?.length ? pages : undefined,
					note: boundedText(artifact.note, "manual artifact note", 10_000),
				},
				urls,
				pages: new Set(pages ?? []),
			});
		}

		const expectedArtifacts = [...expected.values()].map((group) => ({
			...group.entry,
			urls: [...group.urls.values()],
			pages: group.pages.size ? [...group.pages].sort((left, right) => left - right) : group.entry.pages,
		}));
		const annotation: ArtifactGoldAnnotation = {
			schemaVersion: 1,
			annotationStatus: "human-reviewed",
			source: {
				slug: detail.source.slug,
				title: detail.source.title,
				paperId: detail.source.paperId,
				pdfPath: relative(this.annotationRoot, this.pdfPath(detail.source)).replaceAll("\\", "/"),
				pdfSha256: detail.pdfSha256,
				sourceUrl: detail.source.sourceUrl,
			},
			inspection: {
				allPagesReviewed: true,
				pageCount: detail.pageCount,
				reviewedPages,
				reviewer,
				reviewedAt,
				notes,
			},
			expectedArtifacts,
			ignoredUrls: [...ignored.values()],
			detectorCandidates: detail.candidates,
		};
		validateArtifactGoldAnnotation(annotation);
		return annotation;
	}

	private async reviewOperation(
		slug: string,
		input: unknown,
	): Promise<{
		annotation: ArtifactGoldAnnotation;
		content: string;
		path: string;
		plan: OperationPlan;
	}> {
		const detail = await this.detail(slug);
		const annotation = this.normalizeSubmission(detail, input);
		const content = `${JSON.stringify(annotation, null, 2)}\n`;
		const previous = await this.existingAnnotation(detail.source);
		const path = join(this.annotationRoot, `${slug}.json`);
		return {
			annotation,
			content,
			path,
			plan: {
				kind: "artifact-evaluation-write",
				summary:
					"Save human-reviewed artifact gold for " +
					detail.source.title +
					" (" +
					annotation.expectedArtifacts.length +
					" expected, " +
					annotation.ignoredUrls.length +
					" ignored)",
				actor: annotation.inspection.reviewer,
				targets: [
					{ label: "Reviewed annotation", value: path, risk: "high" },
					...annotation.expectedArtifacts.slice(0, 100).map((artifact) => ({
						label: `Expected artifact ${artifact.id}`,
						value: artifact.urls.join(" | "),
						risk: "medium" as const,
					})),
				],
				details: {
					slug,
					pdfSha256: detail.pdfSha256,
					pageCount: detail.pageCount,
					annotationSha256: sha256(content),
					previousAnnotationSha256: previous.hash ?? null,
					annotation,
				},
			},
		};
	}

	async prepare(slug: string, input: unknown): Promise<PreparedOperation> {
		return this.consent.prepare((await this.reviewOperation(slug, input)).plan);
	}

	async save(slug: string, input: unknown, grant: ConfirmationGrant) {
		const prepared = await this.reviewOperation(slug, input);
		await this.consent.consume(grant, prepared.plan);
		await mkdir(this.annotationRoot, { recursive: true });
		const temporary = `${prepared.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, prepared.content, { encoding: "utf8", flag: "wx" });
			await rename(temporary, prepared.path);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
		const saved = JSON.parse(await readFile(prepared.path, "utf8")) as ArtifactGoldAnnotation;
		validateArtifactGoldAnnotation(saved);
		return {
			path: prepared.path,
			annotation: saved,
			annotationSha256: sha256(prepared.content),
		};
	}
}
