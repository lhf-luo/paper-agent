import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	mergePaperRecords,
	normalizeArxivId,
	normalizeDoi,
	normalizeTitle,
	samePaperIdentity,
} from "../domain/literature-identifiers.ts";
import {
	proposedByIdentity,
	type TeamContributor,
	type TeamLiteratureRepository,
	TeamPaperConflictError,
} from "../domain/team-literature-repository.ts";
import type {
	CorpusManifest,
	CorpusSearchHit,
	PaperCuration,
	PaperRecord,
	PaperVersion,
	ScreeningStatus,
} from "../protocol/literature-types.ts";
import type { SharedReviewStatus } from "../protocol/team-corpus-types.ts";
import {
	readJson,
	removeTeamFile,
	safeSegment,
	stableFingerprint,
	writeJsonAtomic,
} from "./team-knowledge-serialization.ts";

/**
 * The content a review decision actually vouches for: which paper this is (normalized title, year,
 * identifiers), what it says (normalized abstract), and what readers may download on the strength of the
 * approval (pdf/artifact links).
 *
 * Everything else is deliberately excluded. Merge bookkeeping (`mergedFrom`, recomputed ids), discovery
 * metadata (`provenance`, `discoveryPaths`), volatile metrics (`citationCount`, `referencedWorks`), provider
 * formatting differences in author lists, venue/type enrichment, material hashes, and landing/doi links all
 * change every time a second member re-proposes the same paper from a different search. Treating those as
 * "content changes" would knock approved records back into review (and out of reader view) on every duplicate
 * proposal, which the collaboration flow depends on not happening.
 */
function reviewableContent(record: PaperRecord): Record<string, unknown> {
	return {
		title: normalizeTitle(record.title),
		abstract: normalizeSearchText(record.abstract ?? "") || undefined,
		year: record.year,
		identifiers: {
			doi: normalizeDoi(record.identifiers.doi),
			arxivId: normalizeArxivId(record.identifiers.arxivId),
			openAlexId: record.identifiers.openAlexId?.toLowerCase(),
			semanticScholarId: record.identifiers.semanticScholarId?.toLowerCase(),
		},
		downloadLinks: record.links
			.filter((link) => link.kind === "pdf" || link.kind === "artifact")
			.map((link) => `${link.kind} ${link.url}`)
			.sort(),
	};
}

function hasIdentitySignals(record: PaperRecord): boolean {
	return Boolean(
		normalizeDoi(record.identifiers.doi) ||
			normalizeArxivId(record.identifiers.arxivId) ||
			record.identifiers.openAlexId ||
			record.identifiers.semanticScholarId ||
			record.materialHashes?.length ||
			record.provenance.some((event) => event.providerRecordId),
	);
}

/**
 * A proposal that reuses an existing team id must describe the same paper. Without this check a contributor
 * could copy an id from any search result and merge a foreign title and download links into the approved
 * record (knocking it back into review at the same time). Records that carry no identifier evidence at all
 * can only be matched by title.
 */
function assertSamePaper(existing: PaperRecord, record: PaperRecord): void {
	if (samePaperIdentity(existing, record)) return;
	if (
		!hasIdentitySignals(existing) &&
		!hasIdentitySignals(record) &&
		normalizeTitle(existing.title) === normalizeTitle(record.title)
	)
		return;
	throw new TeamPaperConflictError(
		`Paper id ${record.id} already identifies a different paper in the team corpus; propose the record under its own id or with matching identifiers`,
	);
}

function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Records are handed out by reference, so freeze the cached graph: accidental mutation must fail loudly. */
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

export class FileTeamLiteratureRepository implements TeamLiteratureRepository {
	readonly root: string;
	readonly namespace: string;
	private initialized = false;
	/**
	 * In-memory record cache. The team service is a single-instance, single-writer process (documented in
	 * `docs/team-handoff.md`), so no cross-process invalidation is needed; the cache is refreshed in place by
	 * every write path below.
	 */
	private index?: Map<string, PaperRecord>;

	constructor(root: string, namespace: string) {
		this.root = resolve(root);
		this.namespace = namespace;
	}

	/** Drop the cached index. Tests and recovery tooling use this after touching the records directory. */
	invalidate(): void {
		this.index = undefined;
	}

	private recordPath(id: string): string {
		return join(this.root, "records", `${safeSegment(id, "paper id")}.json`);
	}

	private versionPath(paperId: string): string {
		return join(this.root, "paper-versions", `${safeSegment(paperId, "paper id")}.json`);
	}

	private revisionPath(paperId: string): string {
		return join(this.root, "revisions", `${safeSegment(paperId, "paper id")}.json`);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await Promise.all([
			mkdir(join(this.root, "records"), { recursive: true }),
			mkdir(join(this.root, "revisions"), { recursive: true }),
			mkdir(join(this.root, "search-runs"), { recursive: true }),
			mkdir(join(this.root, "derived"), { recursive: true }),
			mkdir(join(this.root, "derived-history"), { recursive: true }),
			mkdir(join(this.root, "paper-versions"), { recursive: true }),
			mkdir(join(this.root, "collections"), { recursive: true }),
			mkdir(join(this.root, "blobs", "sha256"), { recursive: true }),
			mkdir(join(this.root, "exports"), { recursive: true }),
			mkdir(join(this.root, "imports"), { recursive: true }),
		]);
		if (!(await pathExists(join(this.root, "manifest.json")))) await this.refreshManifest();
		this.initialized = true;
	}

	async listPapers(): Promise<PaperRecord[]> {
		if (!this.index) {
			const directory = join(this.root, "records");
			const names = (await readdir(directory).catch(() => [] as string[]))
				.filter((name) => name.endsWith(".json"))
				.sort();
			const records = await Promise.all(names.map((name) => readJson<PaperRecord>(join(directory, name))));
			const index = new Map<string, PaperRecord>();
			for (const record of records) if (record) index.set(record.id, deepFreeze(record));
			this.index = index;
		}
		// Records are frozen and shared: callers must treat them as read-only.
		return [...this.index.values()];
	}

	private getRevision(id: string): Promise<PaperRecord | undefined> {
		return readJson<PaperRecord>(this.revisionPath(id));
	}

	private async listRevisions(): Promise<PaperRecord[]> {
		const directory = join(this.root, "revisions");
		const names = (await readdir(directory).catch(() => [] as string[]))
			.filter((name) => name.endsWith(".json"))
			.sort();
		const revisions = await Promise.all(names.map((name) => readJson<PaperRecord>(join(directory, name))));
		return revisions.filter((record): record is PaperRecord => Boolean(record));
	}

	async listPendingPapers(): Promise<PaperRecord[]> {
		const [records, revisions] = await Promise.all([this.listPapers(), this.listRevisions()]);
		return [...records.filter((record) => record.curation?.teamReview?.status === "team-proposed"), ...revisions];
	}

	private cacheRecord(record: PaperRecord): void {
		this.index?.set(record.id, deepFreeze(record));
	}

	private uncacheRecord(id: string): void {
		this.index?.delete(id);
	}

	getPaper(id: string): Promise<PaperRecord | undefined> {
		return readJson<PaperRecord>(this.recordPath(id));
	}

	async getReviewablePaper(id: string): Promise<PaperRecord | undefined> {
		return (await this.getRevision(id)) ?? this.getPaper(id);
	}

	async searchPapers(options: {
		query?: string;
		yearFrom?: number;
		yearTo?: number;
		authors?: string[];
		venues?: string[];
		tags?: string[];
		identifiers?: string[];
		screeningStatuses?: ScreeningStatus[];
		reviewStatuses?: SharedReviewStatus[];
		types?: string[];
		openAccess?: boolean;
		offset?: number;
		limit?: number;
	}): Promise<CorpusSearchHit[]> {
		const query = normalizeSearchText(options.query ?? "");
		const terms = query.split(" ").filter((term) => term.length > 1);
		const wantedAuthors = (options.authors ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedVenues = (options.venues ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTags = (options.tags ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedIdentifiers = (options.identifiers ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTypes = (options.types ?? []).map(normalizeSearchText).filter(Boolean);
		// Readers must never discover records that are still pending or were rejected.
		const reviewStatuses = options.reviewStatuses ?? (["team-approved"] as SharedReviewStatus[]);
		const hits: CorpusSearchHit[] = [];
		for (const record of await this.listPapers()) {
			if (!reviewStatuses.includes(record.curation?.teamReview?.status as SharedReviewStatus)) continue;
			if (options.yearFrom !== undefined && (record.year === undefined || record.year < options.yearFrom)) continue;
			if (options.yearTo !== undefined && (record.year === undefined || record.year > options.yearTo)) continue;
			const authors = record.authors.map(normalizeSearchText);
			if (
				wantedAuthors.length &&
				!wantedAuthors.every((wanted) => authors.some((author) => author.includes(wanted)))
			)
				continue;
			const venue = normalizeSearchText(record.venue ?? "");
			if (wantedVenues.length && !wantedVenues.some((wanted) => venue.includes(wanted))) continue;
			const publicationType = normalizeSearchText(record.publicationType ?? "");
			if (wantedTypes.length && !wantedTypes.some((wanted) => publicationType.includes(wanted))) continue;
			if (
				options.openAccess !== undefined &&
				!record.links.some((link) => link.kind === "pdf" && link.openAccess === options.openAccess)
			)
				continue;
			const tags = (record.curation?.tags ?? []).map(normalizeSearchText);
			if (wantedTags.length && !wantedTags.every((wanted) => tags.includes(wanted))) continue;
			const identifiers = [record.id, ...Object.values(record.identifiers)]
				.filter((value): value is string => Boolean(value))
				.map(normalizeSearchText);
			if (
				wantedIdentifiers.length &&
				!wantedIdentifiers.every((wanted) => identifiers.some((identifier) => identifier.includes(wanted)))
			)
				continue;
			if (
				options.screeningStatuses?.length &&
				!options.screeningStatuses.includes(record.curation?.screening?.status ?? "unreviewed")
			)
				continue;

			const fields = new Map<string, { text: string; weight: number }>([
				["title", { text: normalizeSearchText(record.title), weight: 8 }],
				["authors", { text: authors.join(" "), weight: 4 }],
				["venue", { text: venue, weight: 3 }],
				["abstract", { text: normalizeSearchText(record.abstract ?? ""), weight: 1 }],
				["tags", { text: tags.join(" "), weight: 6 }],
				["identifiers", { text: identifiers.join(" "), weight: 12 }],
			]);
			let score = 0;
			const matchedFields: string[] = [];
			const matchedTerms = new Set<string>();
			for (const [field, value] of fields) {
				let matched = false;
				if (query && value.text.includes(query)) {
					score += value.weight * 3;
					matched = true;
				}
				for (const term of terms) {
					if (!value.text.includes(term)) continue;
					matchedTerms.add(term);
					score += value.weight;
					matched = true;
				}
				if (matched) matchedFields.push(field);
			}
			if (query && matchedTerms.size < Math.max(1, Math.ceil(terms.length / 2))) continue;
			hits.push({ record, score, matchedFields });
		}
		const offset = Math.max(0, options.offset ?? 0);
		return hits
			.sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))
			.slice(offset, offset + Math.min(options.limit ?? 100, 500));
	}

	async proposePapers(records: PaperRecord[], contributor: string, contributorId?: string): Promise<number> {
		if (!contributor.trim()) throw new Error("Contributor identity is required");
		const proposer: TeamContributor = { name: contributor.trim(), id: contributorId };
		await this.initialize();
		return this.withWriteLock(async () => {
			const candidates = await this.listPapers();
			// Reject id conflicts before writing anything so a batch never lands partially.
			for (const source of records) {
				const direct = candidates.find((candidate) => candidate.id === source.id);
				if (direct) assertSamePaper(direct, source);
			}
			for (const source of records) {
				const proposed: PaperRecord = {
					...structuredClone(source),
					curation: {
						tags: [...(source.curation?.tags ?? [])],
						userNotes: [],
						teamReview: {
							status: "team-proposed",
							proposedBy: proposer.name,
							proposedById: proposer.id,
							proposedAt: new Date().toISOString(),
						},
					},
				};
				await this.upsertPaper(proposed, candidates, proposer);
			}
			await this.refreshManifest();
			return records.length;
		});
	}

	private async upsertPaper(
		record: PaperRecord,
		candidates: PaperRecord[],
		proposer?: TeamContributor,
	): Promise<void> {
		const direct = await this.getPaper(record.id);
		if (direct) assertSamePaper(direct, record);
		const existing = direct ?? candidates.find((candidate) => samePaperIdentity(candidate, record));
		const merged = existing ? mergePaperRecords(existing, record) : record;
		// A record already stored under this id is a re-proposal of the same paper: keep the id stable so
		// existing links, paper versions, and review state stay addressable.
		if (direct) merged.id = direct.id;
		const existingReview = existing?.curation?.teamReview?.status;
		if (
			existing &&
			proposer &&
			(existingReview === "team-approved" || existingReview === "team-rejected") &&
			stableFingerprint(reviewableContent(existing)) !== stableFingerprint(reviewableContent(merged))
		) {
			if (existingReview === "team-approved") {
				// Readers keep the record exactly as reviewed; the new content waits for a reviewer.
				await this.parkRevision(existing, record, proposer);
				return;
			}
			// A rejected record is invisible anyway: reset it in place so reviewers re-check the new content.
			merged.curation = {
				tags: [...(merged.curation?.tags ?? [])],
				userNotes: [],
				teamReview: {
					status: "team-proposed",
					proposedBy: proposer.name,
					proposedById: proposer.id,
					proposedAt: new Date().toISOString(),
				},
			};
		}
		if (!existing || JSON.stringify(existing) !== JSON.stringify(merged))
			await writeJsonAtomic(this.recordPath(merged.id), merged);
		if (existing && existing.id !== merged.id) {
			await removeTeamFile(this.recordPath(existing.id)).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			this.uncacheRecord(existing.id);
		}
		this.cacheRecord(merged);
		const position = existing ? candidates.findIndex((candidate) => candidate.id === existing.id) : -1;
		if (position >= 0) candidates.splice(position, 1, merged);
		else candidates.push(merged);
	}

	/**
	 * Park changed content for an approved record in `revisions/`. The approved record stays untouched (and
	 * visible to readers) until a reviewer approves the revision, which replaces the record, or rejects it,
	 * which simply discards the revision. Further proposals while a revision is pending merge into it.
	 */
	private async parkRevision(approved: PaperRecord, record: PaperRecord, proposer: TeamContributor): Promise<void> {
		const pending = await this.getRevision(approved.id);
		const revision = mergePaperRecords(pending ?? approved, record);
		revision.id = approved.id;
		const review = pending?.curation?.teamReview;
		revision.curation = {
			tags: [...(revision.curation?.tags ?? [])],
			userNotes: [],
			teamReview: {
				status: "team-proposed",
				proposedBy: review?.proposedBy ?? proposer.name,
				proposedById: review?.proposedById ?? proposer.id,
				proposedAt: review?.proposedAt ?? new Date().toISOString(),
				revision: true,
			},
		};
		await writeJsonAtomic(this.revisionPath(approved.id), revision);
	}

	private async removeRevision(id: string): Promise<void> {
		try {
			await removeTeamFile(this.revisionPath(id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async reviewTeamPaper(
		id: string,
		decision: "team-approved" | "team-rejected",
		reviewer: string,
		reason?: string,
	): Promise<PaperRecord> {
		await this.initialize();
		return this.withWriteLock(async () => {
			const revision = await this.getRevision(id);
			if (revision) return this.reviewRevision(id, revision, decision, reviewer, reason);
			const record = await this.getPaper(id);
			if (!record) throw new Error(`Paper not found in team corpus: ${id}`);
			const curation: PaperCuration = structuredClone(record.curation ?? { tags: [], userNotes: [] });
			curation.teamReview = {
				...curation.teamReview,
				status: decision,
				reviewedBy: reviewer,
				reviewedAt: new Date().toISOString(),
				reason: reason?.trim() || undefined,
			};
			const updated = { ...record, curation };
			await this.archivePaper(record, decision, reviewer, reason);
			await this.reviewPendingVersions(id, decision, reviewer, reason);
			await writeJsonAtomic(this.recordPath(id), updated);
			this.cacheRecord(updated);
			await this.refreshManifest();
			return updated;
		});
	}

	private async reviewRevision(
		id: string,
		revision: PaperRecord,
		decision: "team-approved" | "team-rejected",
		reviewer: string,
		reason?: string,
	): Promise<PaperRecord> {
		const approved = await this.getPaper(id);
		await this.archivePaper(revision, decision, reviewer, reason);
		await this.reviewPendingVersions(id, decision, reviewer, reason);
		if (decision === "team-rejected" && approved) {
			// The approved record was never touched, so discarding the revision is the whole rollback.
			await this.removeRevision(id);
			await this.refreshManifest();
			return approved;
		}
		const { revision: _flag, ...review }: NonNullable<PaperCuration["teamReview"]> = revision.curation
			?.teamReview ?? {
			status: "team-proposed",
		};
		const updated: PaperRecord = {
			...revision,
			curation: {
				...(revision.curation ?? { tags: [], userNotes: [] }),
				teamReview: {
					...review,
					status: decision,
					reviewedBy: reviewer,
					reviewedAt: new Date().toISOString(),
					reason: reason?.trim() || undefined,
				},
			},
		};
		await writeJsonAtomic(this.recordPath(id), updated);
		await this.removeRevision(id);
		this.cacheRecord(updated);
		await this.refreshManifest();
		return updated;
	}

	async putBlob(data: Uint8Array): Promise<{ sha256: string; path: string; existed: boolean }> {
		await this.initialize();
		const sha256 = createHash("sha256").update(data).digest("hex");
		const path = join(this.root, "blobs", "sha256", sha256.slice(0, 2), sha256);
		const existed = await pathExists(path);
		if (!existed) {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, data, { flag: "wx" });
				await rename(temporary, path);
			} catch (error) {
				await unlink(temporary).catch(() => undefined);
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await pathExists(path))) throw error;
				return { sha256, path, existed: true };
			}
		}
		return { sha256, path, existed };
	}

	private async archivePaper(record: PaperRecord, decision: string, actor: string, reason?: string): Promise<void> {
		await writeJsonAtomic(
			join(this.root, "history", "papers", safeSegment(record.id, "paper id"), `${Date.now()}-${randomUUID()}.json`),
			{ record, decision, actor, reason, at: new Date().toISOString() },
		);
	}

	private async reviewPendingVersions(
		paperId: string,
		decision: "team-approved" | "team-rejected",
		reviewer: string,
		reason?: string,
	): Promise<void> {
		const versions = (await readJson<PaperVersion[]>(this.versionPath(paperId))) ?? [];
		if (!versions.some((version) => version.teamReview?.status === "team-proposed")) return;
		await writeJsonAtomic(
			this.versionPath(paperId),
			versions.map((version) =>
				version.teamReview?.status === "team-proposed"
					? {
							...version,
							teamReview: {
								...version.teamReview,
								status: decision,
								reviewedBy: reviewer,
								reviewedAt: new Date().toISOString(),
								reason,
							},
						}
					: version,
			),
		);
	}

	async savePaperVersion(version: PaperVersion): Promise<void> {
		await this.initialize();
		await this.withWriteLock(async () => {
			const path = this.versionPath(version.paperId);
			const versions = (await readJson<PaperVersion[]>(path)) ?? [];
			const existing = versions.findIndex(
				(item) => item.sha256 === version.sha256 && item.finalUrl === version.finalUrl,
			);
			if (existing < 0 || versions[existing].teamReview?.status === "team-rejected") {
				if (existing < 0) versions.push(version);
				else versions[existing] = version;
				await writeJsonAtomic(path, versions);
				const paper = await this.getPaper(version.paperId);
				if (
					version.teamReview?.status === "team-proposed" &&
					paper?.curation?.teamReview?.status === "team-approved"
				) {
					await this.parkRevision(paper, paper, {
						name: version.teamReview.proposedBy ?? "contributor",
						id: version.teamReview.proposedById,
					});
				}
			}
		});
	}

	async listPaperVersions(paperId: string): Promise<PaperVersion[]> {
		const versions = (await readJson<PaperVersion[]>(this.versionPath(paperId))) ?? [];
		return versions.sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt));
	}

	/**
	 * Withdraw own pending proposals, including pending revisions of approved records. Every id is validated
	 * before anything is removed, so a batch either succeeds entirely or is rejected wholesale.
	 */
	async withdrawPapers(paperIds: string[], contributor: string, contributorId?: string): Promise<string[]> {
		if (!contributor.trim()) throw new Error("Contributor identity is required");
		const identity: TeamContributor = { name: contributor.trim(), id: contributorId };
		await this.initialize();
		return this.withWriteLock(async () => {
			const targets = await Promise.all(
				paperIds.map(async (id) => {
					const revision = await this.getRevision(id);
					return { id, revision, record: revision ?? (await this.getPaper(id)) };
				}),
			);
			for (const { id, record } of targets) {
				if (!record) throw new Error(`Team paper is not available to withdraw: ${id}`);
				const review = record.curation?.teamReview;
				if (review?.status !== "team-proposed") throw new Error(`Only pending proposals can be withdrawn: ${id}`);
				if (review.reviewedAt) throw new Error(`A reviewed proposal can no longer be withdrawn: ${id}`);
				if (!proposedByIdentity(review, identity))
					throw new Error(`Only the original proposer can withdraw: ${id}`);
			}
			for (const { id, revision } of targets) {
				const source = revision ?? (await this.getPaper(id));
				if (source) await this.archivePaper(source, "withdrawn", contributor);
				await this.reviewPendingVersions(id, "team-rejected", contributor, "Proposal withdrawn");
				if (revision) {
					// Only the parked revision goes; the approved record it would have replaced is untouched.
					await this.removeRevision(id);
					continue;
				}
				await this.removeRecord(id);
				this.uncacheRecord(id);
			}
			await this.refreshManifest();
			return targets.map(({ id }) => id);
		});
	}

	private async removeRecord(id: string): Promise<void> {
		try {
			await removeTeamFile(this.recordPath(id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async audit(): Promise<{
		manifest: CorpusManifest;
		recordsMissingPrimaryLink: string[];
		recordsMissingProvenance: string[];
		teamRecordsPendingReview: string[];
	}> {
		const [records, pending] = await Promise.all([this.listPapers(), this.listPendingPapers()]);
		return {
			manifest: await this.buildManifest(),
			recordsMissingPrimaryLink: records.filter((record) => record.links.length === 0).map((record) => record.id),
			recordsMissingProvenance: records
				.filter((record) => record.provenance.length === 0)
				.map((record) => record.id),
			teamRecordsPendingReview: pending.map((record) => record.id),
		};
	}

	private async buildManifest(): Promise<CorpusManifest> {
		const countJson = async (directory: string) =>
			(await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).length;
		return {
			schemaVersion: 1,
			scope: "team",
			namespace: this.namespace,
			updatedAt: new Date().toISOString(),
			recordCount: await countJson(join(this.root, "records")),
			searchRunCount: await countJson(join(this.root, "search-runs")),
			derivedRecordCount: await countJson(join(this.root, "derived")),
		};
	}

	private async refreshManifest(): Promise<CorpusManifest> {
		const manifest = await this.buildManifest();
		await writeJsonAtomic(join(this.root, "manifest.json"), manifest);
		return manifest;
	}

	private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.root, { recursive: true });
		const lockPath = join(this.root, ".write.lock");
		const deadline = Date.now() + 15_000;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			try {
				handle = await open(lockPath, "wx");
				await handle.writeFile(
					`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
					"utf8",
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const lockStat = await stat(lockPath).catch(() => undefined);
				if (!lockStat) continue;
				if (Date.now() - lockStat.mtimeMs > 120_000) {
					await unlink(lockPath);
					continue;
				}
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for the corpus write lock: ${lockPath}`);
				await delay(50);
			}
		}
		try {
			return await operation();
		} finally {
			await handle.close().catch(() => undefined);
			await unlink(lockPath).catch(() => undefined);
		}
	}
}
