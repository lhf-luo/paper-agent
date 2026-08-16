import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sha256File } from "./artifact-discovery.ts";
import { requestInteractiveOperationAuthorization } from "./interactive-operation-consent.ts";
import { normalizeArxivId, normalizeDoi, paperRecordId, sha256Text } from "./literature-identifiers.ts";
import { LiteratureStore, resolveCorpusRoot } from "./literature-store.ts";
import type { PaperCuration, PaperProvenance, PaperRecord } from "./literature-types.ts";
import type { OperationPlan } from "./operation-consent.ts";

interface ImportRejection {
	source: string;
	reason: "unsupported_format" | "parse_error" | "missing_required_field" | "not_a_file" | "write_error";
	detail: string;
	missingFields?: string[];
}

interface ImportResult {
	accepted: PaperRecord[];
	rejected: ImportRejection[];
}

export function literatureImportPlan(
	store: LiteratureStore,
	inputPath: string,
	accepted: PaperRecord[],
	rejected: ImportRejection[],
	rejectionPath: string,
): OperationPlan {
	const normalized = [...accepted].sort((left, right) => left.id.localeCompare(right.id));
	return {
		kind: "personal-corpus-write",
		summary: `Import ${normalized.length} parsed literature record(s) into ${store.namespace}`,
		targets: [
			{ label: "personal-corpus", value: store.root, risk: "medium" },
			{ label: "rejection-log", value: rejectionPath, risk: "low" },
		],
		details: {
			inputPath,
			corpusPath: store.root,
			namespace: store.namespace,
			recordIds: normalized.map((record) => record.id),
			recordsFingerprint: sha256Text(JSON.stringify(normalized)),
			rejectedCount: rejected.length,
			rejectionsFingerprint: sha256Text(JSON.stringify(rejected)),
		},
	};
}

const linkKinds = new Set(["landing", "pdf", "doi", "artifact", "other"]);
const provenanceProviders = new Set([
	"arxiv",
	"openalex",
	"crossref",
	"semanticscholar",
	"dblp",
	"pubmed",
	"core",
	"opencitations",
	"unpaywall",
	"local-pdf",
	"bibtex-import",
	"json-import",
]);
const screeningStatuses = new Set(["unreviewed", "include", "exclude", "maybe"]);
const teamReviewStatuses = new Set(["personal", "team-proposed", "team-approved", "team-rejected"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isImportedLink(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.url === "string" &&
		linkKinds.has(String(value.kind)) &&
		(value.openAccess === undefined || typeof value.openAccess === "boolean")
	);
}

function isImportedProvenance(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		provenanceProviders.has(String(value.provider)) &&
		typeof value.query === "string" &&
		typeof value.retrievedAt === "string" &&
		isOptionalString(value.providerRecordId) &&
		isOptionalString(value.rawUrl)
	);
}

function isImportedScreening(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		screeningStatuses.has(String(value.status)) &&
		typeof value.updatedBy === "string" &&
		typeof value.updatedAt === "string" &&
		isOptionalString(value.reason)
	);
}

function isImportedTeamReview(value: unknown): boolean {
	if (!isRecord(value) || !teamReviewStatuses.has(String(value.status))) return false;
	return [value.proposedBy, value.proposedAt, value.reviewedBy, value.reviewedAt, value.reason].every(
		isOptionalString,
	);
}

function unquoteBibtex(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function bibtexEntries(content: string): Array<{ type: string; key: string; body: string }> {
	const entries = [];
	let cursor = 0;
	while (cursor < content.length) {
		const at = content.indexOf("@", cursor);
		if (at < 0) break;
		const header = /@(\w+)\s*\{\s*([^,]+),/y;
		header.lastIndex = at;
		const match = header.exec(content);
		if (!match) {
			cursor = at + 1;
			continue;
		}
		const bodyStart = header.lastIndex;
		let depth = 1;
		let quoted = false;
		let escaped = false;
		let end = bodyStart;
		for (; end < content.length; end++) {
			const character = content[end];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') quoted = !quoted;
			if (quoted) continue;
			if (character === "{") depth++;
			if (character === "}") depth--;
			if (depth === 0) break;
		}
		if (depth !== 0) break;
		entries.push({ type: match[1], key: match[2].trim(), body: content.slice(bodyStart, end) });
		cursor = end + 1;
	}
	return entries;
}

export function parseBibtex(content: string, source: string): ImportResult {
	const accepted: PaperRecord[] = [];
	const rejected: ImportRejection[] = [];
	for (const entry of bibtexEntries(content)) {
		const key = entry.key;
		const fields = new Map<string, string>();
		for (const field of entry.body.matchAll(/(\w[\w-]*)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n]+)\s*,?/g)) {
			fields.set(field[1].toLowerCase(), unquoteBibtex(field[2]));
		}
		const title = fields.get("title")?.replace(/[{}]/g, "").trim();
		const authorText = fields.get("author");
		const authors =
			authorText
				?.split(/\s+and\s+/i)
				.map((author) => author.trim())
				.filter(Boolean) ?? [];
		const yearText = fields.get("year")?.match(/\d{4}/)?.[0];
		if (!title || authors.length === 0) {
			rejected.push({
				source: `${source}#${key}`,
				reason: "missing_required_field",
				detail: "BibTeX entry requires title and at least one author",
				missingFields: [!title ? "title" : undefined, authors.length === 0 ? "authors" : undefined].filter(
					(value): value is string => Boolean(value),
				),
			});
			continue;
		}
		const retrievedAt = new Date().toISOString();
		const identifiers = {
			doi: normalizeDoi(fields.get("doi")),
			arxivId: normalizeArxivId(fields.get("eprint")),
		};
		const links: PaperRecord["links"] = [];
		const url = fields.get("url");
		if (url) links.push({ url, kind: "landing" as const });
		if (identifiers.doi && !links.some((link) => link.url === `https://doi.org/${identifiers.doi}`)) {
			links.push({ url: `https://doi.org/${identifiers.doi}`, kind: "doi" as const });
		}
		const record: PaperRecord = {
			id: "",
			title,
			authors,
			year: yearText ? Number(yearText) : undefined,
			venue: fields.get("booktitle") ?? fields.get("journal"),
			publicationType: entry.type.toLowerCase(),
			identifiers,
			links,
			provenance: [
				{
					provider: "bibtex-import",
					query: `import:${key}`,
					retrievedAt,
					providerRecordId: key,
					rawUrl: source,
				},
			],
			mergedFrom: [],
		};
		record.id = paperRecordId(record);
		accepted.push(record);
	}
	if (accepted.length === 0 && rejected.length === 0) {
		rejected.push({ source, reason: "parse_error", detail: "No BibTeX entries were recognized" });
	}
	return { accepted, rejected };
}

export function parseJsonExport(value: unknown, source: string): ImportResult {
	const records = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && Array.isArray((value as { records?: unknown }).records)
			? (value as { records: unknown[] }).records
			: undefined;
	if (!records) return { accepted: [], rejected: [{ source, reason: "parse_error", detail: "Expected records[]" }] };
	const accepted: PaperRecord[] = [];
	const rejected: ImportRejection[] = [];
	for (const [index, value] of records.entries()) {
		if (
			typeof value !== "object" ||
			value === null ||
			typeof (value as PaperRecord).title !== "string" ||
			(value as PaperRecord).title.trim().length === 0 ||
			!Array.isArray((value as PaperRecord).authors) ||
			(value as PaperRecord).authors.length === 0 ||
			!(value as PaperRecord).authors.every((author) => typeof author === "string" && author.trim().length > 0)
		) {
			rejected.push({
				source: `${source}#records[${index}]`,
				reason: "missing_required_field",
				detail: "JSON record requires title and authors[]",
				missingFields: ["title", "authors"],
			});
			continue;
		}
		const imported = value as Record<string, unknown>;
		const invalidLinks =
			imported.links !== undefined && (!Array.isArray(imported.links) || !imported.links.every(isImportedLink));
		const invalidProvenance =
			imported.provenance !== undefined &&
			(!Array.isArray(imported.provenance) || !imported.provenance.every(isImportedProvenance));
		const invalidStringArrays = [imported.referencedWorks, imported.mergedFrom].some(
			(field) => field !== undefined && (!Array.isArray(field) || !field.every((item) => typeof item === "string")),
		);
		const invalidHashes =
			imported.materialHashes !== undefined &&
			(!Array.isArray(imported.materialHashes) ||
				!imported.materialHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)));
		if (invalidLinks || invalidProvenance || invalidStringArrays || invalidHashes) {
			rejected.push({
				source: `${source}#records[${index}]`,
				reason: "parse_error",
				detail: "JSON links, provenance, hashes, and reference lists must use the paper-agent schema",
			});
			continue;
		}
		const importedIdentifiers = isRecord(imported.identifiers)
			? (imported.identifiers as Record<string, unknown>)
			: {};
		const stringValue = (field: unknown) => (typeof field === "string" ? field : undefined);
		const links: PaperRecord["links"] = Array.isArray(imported.links)
			? imported.links.map((link) => {
					const item = link as Record<string, unknown>;
					return {
						url: item.url as string,
						kind: item.kind as PaperRecord["links"][number]["kind"],
						openAccess: typeof item.openAccess === "boolean" ? item.openAccess : undefined,
					};
				})
			: [];
		const provenance: PaperProvenance[] = Array.isArray(imported.provenance)
			? imported.provenance.map((event) => {
					const item = event as Record<string, unknown>;
					return {
						provider: item.provider as PaperProvenance["provider"],
						query: item.query as string,
						retrievedAt: item.retrievedAt as string,
						providerRecordId: stringValue(item.providerRecordId),
						rawUrl: stringValue(item.rawUrl),
					};
				})
			: [];
		let curation: PaperCuration | undefined;
		if (imported.curation !== undefined && !isRecord(imported.curation)) {
			rejected.push({
				source: `${source}#records[${index}]`,
				reason: "parse_error",
				detail: "JSON curation must use the paper-agent schema",
			});
			continue;
		}
		if (isRecord(imported.curation)) {
			const value = imported.curation as Record<string, unknown>;
			if (
				(value.tags !== undefined &&
					(!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string"))) ||
				(value.userNotes !== undefined &&
					(!Array.isArray(value.userNotes) ||
						!value.userNotes.every(
							(note) =>
								typeof note === "object" &&
								note !== null &&
								typeof (note as Record<string, unknown>).id === "string" &&
								typeof (note as Record<string, unknown>).text === "string" &&
								typeof (note as Record<string, unknown>).author === "string" &&
								typeof (note as Record<string, unknown>).createdAt === "string",
						))) ||
				(value.screening !== undefined && !isImportedScreening(value.screening)) ||
				(value.teamReview !== undefined && !isImportedTeamReview(value.teamReview))
			) {
				rejected.push({
					source: `${source}#records[${index}]`,
					reason: "parse_error",
					detail: "JSON curation tags and userNotes must use the paper-agent schema",
				});
				continue;
			}
			const tags = Array.isArray(value.tags)
				? value.tags.filter((tag): tag is string => typeof tag === "string")
				: [];
			const userNotes = Array.isArray(value.userNotes)
				? value.userNotes.flatMap((note) => {
						if (typeof note !== "object" || note === null) return [];
						const item = note as Record<string, unknown>;
						return typeof item.id === "string" &&
							typeof item.text === "string" &&
							typeof item.author === "string" &&
							typeof item.createdAt === "string"
							? [{ id: item.id, text: item.text, author: item.author, createdAt: item.createdAt }]
							: [];
					})
				: [];
			const screeningValue = isRecord(value.screening) ? value.screening : undefined;
			const screening = screeningValue
				? {
						status: screeningValue.status as NonNullable<PaperCuration["screening"]>["status"],
						reason: stringValue(screeningValue.reason),
						updatedBy: screeningValue.updatedBy as string,
						updatedAt: screeningValue.updatedAt as string,
					}
				: undefined;
			const teamReviewValue = isRecord(value.teamReview) ? value.teamReview : undefined;
			const teamReview = teamReviewValue
				? {
						status: teamReviewValue.status as NonNullable<PaperCuration["teamReview"]>["status"],
						proposedBy: stringValue(teamReviewValue.proposedBy),
						proposedAt: stringValue(teamReviewValue.proposedAt),
						reviewedBy: stringValue(teamReviewValue.reviewedBy),
						reviewedAt: stringValue(teamReviewValue.reviewedAt),
						reason: stringValue(teamReviewValue.reason),
					}
				: undefined;
			curation = { tags, userNotes, screening, teamReview };
		}
		const record: PaperRecord = {
			id: "",
			title: imported.title as string,
			abstract: stringValue(imported.abstract),
			authors: imported.authors as string[],
			year: typeof imported.year === "number" && Number.isInteger(imported.year) ? imported.year : undefined,
			venue: stringValue(imported.venue),
			publicationType: stringValue(imported.publicationType),
			identifiers: {
				doi: normalizeDoi(stringValue(importedIdentifiers.doi)),
				arxivId: normalizeArxivId(stringValue(importedIdentifiers.arxivId)),
				openAlexId: stringValue(importedIdentifiers.openAlexId),
				semanticScholarId: stringValue(importedIdentifiers.semanticScholarId),
			},
			links,
			materialHashes: imported.materialHashes as string[] | undefined,
			citationCount:
				typeof imported.citationCount === "number" && Number.isInteger(imported.citationCount)
					? imported.citationCount
					: undefined,
			referencedWorks: imported.referencedWorks as string[] | undefined,
			citedByApiUrl: stringValue(imported.citedByApiUrl),
			provenance: [
				...provenance,
				{
					provider: "json-import",
					query: "local-json-import",
					retrievedAt: new Date().toISOString(),
					rawUrl: source,
				},
			],
			mergedFrom: (imported.mergedFrom as string[] | undefined) ?? [],
			curation,
		};
		record.id = paperRecordId(record);
		accepted.push(record);
	}
	return { accepted, rejected };
}

async function importPdf(path: string, pi: ExtensionAPI, signal?: AbortSignal): Promise<ImportResult> {
	const info = await pi.exec("pdfinfo", [path], { cwd: dirname(path), signal, timeout: 30_000 });
	if (info.code !== 0 || info.killed || signal?.aborted) {
		return {
			accepted: [],
			rejected: [{ source: path, reason: "parse_error", detail: info.stderr.trim() || "pdfinfo failed" }],
		};
	}
	const metadata = new Map<string, string>();
	for (const line of info.stdout.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator > 0) metadata.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
	}
	const title = metadata.get("title") || basename(path, extname(path)).replace(/[_-]+/g, " ");
	const authors =
		metadata
			.get("author")
			?.split(/\s*(?:;|,\s+(?=[A-Z]))\s*/)
			.filter(Boolean) ?? [];
	const record: PaperRecord = {
		id: "",
		title,
		authors,
		identifiers: {},
		links: [{ url: new URL(`file:///${path.replaceAll("\\", "/")}`).href, kind: "other" }],
		materialHashes: [await sha256File(path)],
		provenance: [
			{
				provider: "local-pdf",
				query: "local-pdf-import",
				retrievedAt: new Date().toISOString(),
				rawUrl: path,
			},
		],
		mergedFrom: [],
	};
	record.id = paperRecordId(record);
	return { accepted: [record], rejected: [] };
}

async function listImportFiles(inputPath: string): Promise<string[]> {
	const inputStat = await stat(inputPath);
	if (inputStat.isFile()) return [inputPath];
	if (!inputStat.isDirectory()) return [];
	const files: string[] = [];
	const pending = [inputPath];
	while (pending.length && files.length < 5_000) {
		const directory = pending.shift();
		if (!directory) break;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && [".pdf", ".bib", ".json"].includes(extname(entry.name).toLowerCase()))
				files.push(path);
		}
	}
	return files.sort();
}

export function registerLiteratureImportTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "import_literature_corpus",
		label: "Import literature corpus",
		description:
			"Import a local PDF, directory of PDFs, BibTeX file, or paper-agent JSON export into a persistent personal corpus. Entries fail softly into a structured rejection log. Team writes remain available only through promote/review.",
		promptSnippet: "Ingest an existing local literature collection into a personal corpus",
		promptGuidelines: [
			"Inspect the rejection log and fix or disclose rejected entries; do not silently discard them.",
			"Local PDF metadata may be incomplete. Preserve unknown fields rather than inventing authors or identifiers.",
		],
		parameters: Type.Object({
			input_path: Type.String(),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const inputPath = resolve(ctx.cwd, params.input_path);
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", namespace, params.corpus_root),
				"personal",
				namespace,
			);
			const accepted: PaperRecord[] = [];
			const rejected: ImportRejection[] = [];
			let files: string[];
			try {
				files = await listImportFiles(inputPath);
			} catch (error) {
				throw new Error(`Could not read import path: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (files.length === 0) throw new Error("Import path contained no .pdf, .bib, or .json files");
			for (const path of files) {
				try {
					const extension = extname(path).toLowerCase();
					const result =
						extension === ".pdf"
							? await importPdf(path, pi, signal)
							: extension === ".bib"
								? parseBibtex(await readFile(path, "utf8"), path)
								: parseJsonExport(JSON.parse(await readFile(path, "utf8")), path);
					accepted.push(...result.accepted);
					rejected.push(...result.rejected);
				} catch (error) {
					rejected.push({
						source: path,
						reason: "parse_error",
						detail: error instanceof Error ? error.message : String(error),
					});
				}
			}
			const rejectionId = `import-${randomUUID()}`;
			const rejectionPath = join(store.root, "imports", `${rejectionId}-rejections.json`);
			const plan = literatureImportPlan(store, inputPath, accepted, rejected, rejectionPath);
			const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
				title: "Import literature into the personal corpus?",
				unavailableMessage:
					"Literature import requires interactive confirmation before records or rejection logs are written.",
				details: () => [`Parsed records: ${accepted.length}`, `Initial rejections: ${rejected.length}`],
			});
			await authorization.manager.consume(authorization.grant, plan);
			const counts = { created: 0, updated: 0, unchanged: 0 };
			let imported = 0;
			for (const outcome of await store.upsertPapers(accepted)) {
				if (outcome.status) {
					counts[outcome.status]++;
					imported++;
				} else {
					rejected.push({
						source: `record:${outcome.record.id}`,
						reason: "write_error",
						detail: outcome.error ?? "unknown corpus write error",
					});
				}
			}
			// 把本地导入的 PDF 文件本体也存进库(blob + paper-versions), 便于在 PDF 工作区按标题选择分析
			for (const record of accepted) {
				if (record.provenance[0]?.provider !== "local-pdf") continue;
				const sourcePath = record.provenance[0].rawUrl;
				if (!sourcePath) continue;
				try {
					const body = new Uint8Array(await readFile(sourcePath));
					const blob = await store.putBlob(body);
					const fileUrl = `file:///${sourcePath.replaceAll("\\", "/")}`;
					await store.savePaperVersion({
						paperId: record.id,
						sourceUrl: fileUrl,
						finalUrl: fileUrl,
						retrievedAt: new Date().toISOString(),
						sha256: blob.sha256,
						bytes: body.length,
						blobPath: blob.path,
						contentType: "application/pdf",
					});
				} catch {
					// 文件本体入库是尽力而为; 元数据记录仍保留
				}
			}
			const rejectionLog = {
				schemaVersion: 1,
				id: rejectionId,
				generatedAt: new Date().toISOString(),
				inputPath,
				parsed: accepted.length,
				imported,
				rejected,
			};
			await store.initialize();
			await mkdir(dirname(rejectionPath), { recursive: true });
			await writeFile(rejectionPath, JSON.stringify(rejectionLog, null, 2) + "\n", "utf8");
			return {
				content: [
					{
						type: "text",
						text: [
							`Parsed/imported records: ${accepted.length}/${imported}`,
							`Created/updated/unchanged: ${counts.created}/${counts.updated}/${counts.unchanged}`,
							`Rejected: ${rejected.length}`,
							`Corpus: ${store.root}`,
							`Rejection log: ${rejectionPath}`,
						].join("\n"),
					},
				],
				details: {
					counts,
					parsed: accepted.length,
					imported,
					rejected,
					corpusPath: store.root,
					rejectionPath,
				},
			};
		},
	});
}
