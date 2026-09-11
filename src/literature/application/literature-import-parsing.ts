import { normalizeArxivId, normalizeDoi, paperRecordId } from "../domain/literature-identifiers.ts";
import type { PaperCuration, PaperProvenance, PaperRecord } from "../domain/literature-types.ts";

export interface ImportRejection {
	source: string;
	reason: "unsupported_format" | "parse_error" | "missing_required_field" | "not_a_file" | "write_error";
	detail: string;
	missingFields?: string[];
}

interface ImportResult {
	accepted: PaperRecord[];
	rejected: ImportRejection[];
}

const linkKinds = new Set(["landing", "pdf", "doi", "artifact", "other"]);
const provenanceProviders = new Set([
	"arxiv",
	"openalex",
	"crossref",
	"semanticscholar",
	"dblp",
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
