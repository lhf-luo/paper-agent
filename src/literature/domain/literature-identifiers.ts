import { createHash } from "node:crypto";
import type {
	PaperCuration,
	PaperDiscoveryPath,
	PaperLink,
	PaperMetadataConflicts,
	PaperRecord,
	PossibleDuplicate,
} from "./literature-types.ts";
import { cleanPaperText, cleanPaperTitle } from "./paper-title.ts";

const linkKindPriority: Record<PaperLink["kind"], number> = {
	other: 0,
	landing: 1,
	doi: 2,
	artifact: 3,
	pdf: 4,
};

export function uniquePaperLinks(links: PaperLink[]): PaperLink[] {
	const unique = new Map<string, PaperLink>();
	for (const original of links) {
		const detectedPdfUrl = paperPdfUrl(original);
		const link =
			detectedPdfUrl && original.kind !== "pdf"
				? { ...original, url: detectedPdfUrl, kind: "pdf" as const }
				: original;
		const existing = unique.get(link.url);
		if (!existing) {
			unique.set(link.url, link);
			continue;
		}
		const preferred = linkKindPriority[link.kind] > linkKindPriority[existing.kind] ? link : existing;
		const openAccess =
			existing.openAccess === true || link.openAccess === true ? true : (existing.openAccess ?? link.openAccess);
		unique.set(link.url, openAccess === undefined ? preferred : { ...preferred, openAccess });
	}
	return [...unique.values()];
}

export function paperPdfUrl(link: PaperLink): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(link.url);
	} catch {
		return undefined;
	}
	if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
	const pathLooksLikePdf =
		/\.pdf$/i.test(parsed.pathname) ||
		/\/doi\/pdf(?:\/|$)/i.test(parsed.pathname) ||
		/\/pdf(?:\/|$)/i.test(parsed.pathname);
	if (link.kind !== "pdf" && !pathLooksLikePdf) return undefined;
	parsed.hash = "";
	return parsed.href;
}

function paperPdfUrls(record: Pick<PaperRecord, "links">): string[] {
	return record.links.map(paperPdfUrl).filter((url): url is string => Boolean(url));
}

export function sha256Text(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function normalizeDoi(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "")
		.replace(/[)\],.;]+$/g, "")
		.toLowerCase();
	return /^10\.\d{4,9}\/\S+$/.test(normalized) ? normalized : undefined;
}

export function canonicalDoiUrl(record: Pick<PaperRecord, "identifiers">): string | undefined {
	const doi = normalizeDoi(record.identifiers.doi);
	return doi ? `https://doi.org/${doi}` : undefined;
}

export function paperPrimaryUrl(record: Pick<PaperRecord, "identifiers" | "links">): string | undefined {
	const doiUrl = canonicalDoiUrl(record);
	if (doiUrl) return doiUrl;
	const explicitDoiUrl = record.links.find((link) => link.kind === "doi")?.url;
	if (explicitDoiUrl) return explicitDoiUrl;
	const arxivId = normalizeArxivId(record.identifiers.arxivId);
	if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
	return (
		record.links.find((link) => link.kind === "landing")?.url ??
		record.links.find((link) => link.kind === "pdf")?.url ??
		record.links.find((link) => link.kind === "other")?.url ??
		record.links[0]?.url
	);
}

export function withCanonicalPaperLinks(record: PaperRecord): PaperRecord {
	const doi = normalizeDoi(record.identifiers.doi);
	if (!doi) return { ...record, links: uniquePaperLinks(record.links) };
	const otherLinks = record.links.filter((link) => normalizeDoi(link.url) !== doi);
	return {
		...record,
		links: uniquePaperLinks([{ url: `https://doi.org/${doi}`, kind: "doi" }, ...otherLinks]),
	};
}

export function normalizeArxivId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value
		.trim()
		.replace(/^arxiv:\s*/i, "")
		.replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
		.replace(/\.pdf$/i, "")
		.replace(/v\d+$/i, "");
	return /^(?:[a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})$/i.test(normalized) ? normalized.toLowerCase() : undefined;
}

function collapseLayoutSpacedTitlePrefix(value: string): string {
	return value
		.trim()
		.replace(/^(?:\p{Lu}\s+\p{Lu}{2,})(?:\s+\p{Lu}\s+\p{Lu}{2,})+(?=\s*[:：])/u, (match) =>
			match.replace(/\s+/g, ""),
		);
}

function hasLayoutSpacedTitlePrefix(value: string): boolean {
	return collapseLayoutSpacedTitlePrefix(value) !== value.trim();
}

export function normalizeTitle(value: string): string {
	return collapseLayoutSpacedTitlePrefix(value)
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function normalizeAuthor(value: string | undefined): string {
	return (value ?? "")
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeFirstAuthorIdentity(value: string | undefined): string {
	const normalized = (value ?? "").normalize("NFKD").toLowerCase().trim();
	const commaParts = normalized
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const ordered = commaParts.length === 2 ? `${commaParts[1]} ${commaParts[0]}` : normalized;
	return ordered.replace(/[^\p{L}\p{N}]+/gu, "");
}

function titleFirstAuthorIdentityKey(record: Pick<PaperRecord, "title" | "authors">): string | undefined {
	const title = normalizeTitle(record.title);
	const firstAuthor = normalizeFirstAuthorIdentity(record.authors[0]);
	return title && firstAuthor ? `${title}:${firstAuthor}` : undefined;
}

function hasConflictingPrimaryIdentifiers(
	left: Pick<PaperRecord, "identifiers">,
	right: Pick<PaperRecord, "identifiers">,
): boolean {
	const leftDoi = normalizeDoi(left.identifiers.doi);
	const rightDoi = normalizeDoi(right.identifiers.doi);
	if (leftDoi && rightDoi && leftDoi !== rightDoi) return true;
	const leftArxiv = normalizeArxivId(left.identifiers.arxivId);
	const rightArxiv = normalizeArxivId(right.identifiers.arxivId);
	return Boolean(leftArxiv && rightArxiv && leftArxiv !== rightArxiv);
}

function sameTitleAndFirstAuthor(
	left: Pick<PaperRecord, "title" | "authors" | "identifiers">,
	right: Pick<PaperRecord, "title" | "authors" | "identifiers">,
): boolean {
	const leftKey = titleFirstAuthorIdentityKey(left);
	return Boolean(
		leftKey && leftKey === titleFirstAuthorIdentityKey(right) && !hasConflictingPrimaryIdentifiers(left, right),
	);
}

export function sameLocalPdfMetadataIdentity(
	left: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "provenance">,
	right: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "provenance">,
): boolean {
	if (![...left.provenance, ...right.provenance].some((item) => item.provider === "local-pdf")) return false;
	if (!hasLayoutSpacedTitlePrefix(left.title) && !hasLayoutSpacedTitlePrefix(right.title)) return false;
	return sameTitleAndFirstAuthor(left, right);
}

export function paperDedupKey(
	record: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes">,
): string {
	const doi = normalizeDoi(record.identifiers.doi);
	if (doi) return `doi:${doi}`;
	const arxivId = normalizeArxivId(record.identifiers.arxivId);
	if (arxivId) return `arxiv:${arxivId}`;
	const materialHash = record.materialHashes?.find((value) => /^[a-f0-9]{64}$/i.test(value));
	if (materialHash) return `material:${materialHash.toLowerCase()}`;
	return `metadata:${paperMetadataKey(record)}`;
}

export function paperMetadataKey(record: Pick<PaperRecord, "title" | "authors" | "year">): string {
	return [normalizeTitle(record.title), normalizeAuthor(record.authors[0]), record.year ?? "unknown"].join(":");
}

export function samePaperIdentity(
	left: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes" | "provenance" | "links">,
	right: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes" | "provenance" | "links">,
): boolean {
	const leftDoi = normalizeDoi(left.identifiers.doi);
	const rightDoi = normalizeDoi(right.identifiers.doi);
	if (leftDoi && rightDoi && leftDoi === rightDoi) return true;
	const leftArxiv = normalizeArxivId(left.identifiers.arxivId);
	const rightArxiv = normalizeArxivId(right.identifiers.arxivId);
	if (leftArxiv && rightArxiv && leftArxiv === rightArxiv) return true;
	if (
		left.identifiers.openAlexId &&
		right.identifiers.openAlexId &&
		left.identifiers.openAlexId.toLowerCase() === right.identifiers.openAlexId.toLowerCase()
	) {
		return true;
	}
	if (
		left.identifiers.semanticScholarId &&
		right.identifiers.semanticScholarId &&
		left.identifiers.semanticScholarId.toLowerCase() === right.identifiers.semanticScholarId.toLowerCase()
	) {
		return true;
	}
	const leftHashes = new Set((left.materialHashes ?? []).map((value) => value.toLowerCase()));
	if ((right.materialHashes ?? []).some((value) => leftHashes.has(value.toLowerCase()))) return true;
	const leftPdfUrls = new Set(paperPdfUrls(left));
	if (paperPdfUrls(right).some((url) => leftPdfUrls.has(url))) return true;
	const leftProviderRecords = new Set(
		left.provenance
			.filter((item) => item.providerRecordId)
			.map((item) => `${item.provider}:${item.providerRecordId}`.toLowerCase()),
	);
	if (
		right.provenance.some(
			(item) =>
				item.providerRecordId && leftProviderRecords.has(`${item.provider}:${item.providerRecordId}`.toLowerCase()),
		)
	) {
		return true;
	}
	return sameTitleAndFirstAuthor(left, right);
}

export function paperRecordId(
	record: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes" | "provenance" | "links">,
): string {
	const doi = normalizeDoi(record.identifiers.doi);
	if (doi) return `doi-${sha256Text(doi).slice(0, 20)}`;
	const arxivId = normalizeArxivId(record.identifiers.arxivId);
	if (arxivId) return `arxiv-${arxivId.replace(/[^a-z0-9]+/gi, "-")}`;
	const materialHash = record.materialHashes?.find((value) => /^[a-f0-9]{64}$/i.test(value));
	if (materialHash) return `material-${materialHash.slice(0, 20).toLowerCase()}`;
	const sourceIdentity =
		record.provenance
			.map((item) => [item.provider, item.providerRecordId ?? "", item.rawUrl ?? ""].join(":"))
			.find((value) => !value.endsWith("::")) ??
		record.links.map((link) => link.url).sort()[0] ??
		"source-unknown";
	return `paper-${sha256Text(`${paperMetadataKey(record)}:${sourceIdentity}`).slice(0, 20)}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value) continue;
		const key = value.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(value.trim());
	}
	return result;
}

function uniqueDiscoveryPaths(values: Array<PaperDiscoveryPath | undefined>): PaperDiscoveryPath[] {
	const seen = new Set<string>();
	const result: PaperDiscoveryPath[] = [];
	for (const value of values) {
		if (!value) continue;
		const key = [
			value.kind,
			value.query ?? "",
			value.provider ?? "",
			value.seedPaperId ?? "",
			value.sourceUrl ?? "",
			value.note ?? "",
		].join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(value);
	}
	return result.sort((left, right) => left.discoveredAt.localeCompare(right.discoveredAt));
}

function mergeCuration(left: PaperCuration | undefined, right: PaperCuration | undefined): PaperCuration | undefined {
	if (!left) return right;
	if (!right) return left;
	const notes = new Map(left.userNotes.map((note) => [note.id, note]));
	for (const note of right.userNotes) if (!notes.has(note.id)) notes.set(note.id, note);
	const screening =
		(left.screening?.updatedAt ?? "") >= (right.screening?.updatedAt ?? "") ? left.screening : right.screening;
	const reviewTimestamp = (review: PaperCuration["teamReview"]): string =>
		review?.reviewedAt ?? review?.proposedAt ?? "";
	const reviewed = [left.teamReview, right.teamReview].filter(
		(review) => review?.status === "team-approved" || review?.status === "team-rejected",
	);
	const teamReview = reviewed.length
		? reviewed.sort((a, b) => reviewTimestamp(b).localeCompare(reviewTimestamp(a)))[0]
		: reviewTimestamp(left.teamReview) >= reviewTimestamp(right.teamReview)
			? left.teamReview
			: right.teamReview;
	return {
		tags: uniqueStrings([...left.tags, ...right.tags]),
		userNotes: [...notes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		screening,
		teamReview,
	};
}

const METADATA_CONFLICT_FIELDS = ["authors", "year", "venue", "publicationType", "citedByApiUrl"] as const;

function metadataSources(record: PaperRecord): string[] {
	return uniqueStrings(record.provenance.map((item) => item.provider));
}

function normalizedMetadataValue(value: string | number | string[]): string {
	if (Array.isArray(value)) return JSON.stringify(value.map((item) => item.trim().toLowerCase()));
	return typeof value === "string" ? value.trim().toLowerCase() : String(value);
}

export function mergePaperMetadataConflicts(left: PaperRecord, right: PaperRecord): PaperMetadataConflicts | undefined {
	const merged: PaperMetadataConflicts = {};
	const add = (
		field: (typeof METADATA_CONFLICT_FIELDS)[number],
		value: string | number | string[] | undefined,
		sources: string[],
	) => {
		if (value === undefined || (typeof value === "string" && !value.trim())) return;
		const bucket = merged[field] ?? [];
		const key = normalizedMetadataValue(value);
		const existing = bucket.find((item) => normalizedMetadataValue(item.value) === key);
		if (existing) existing.sources = uniqueStrings([...existing.sources, ...sources]);
		else bucket.push({ value: Array.isArray(value) ? [...value] : value, sources });
		merged[field] = bucket;
	};
	for (const record of [left, right]) {
		for (const field of METADATA_CONFLICT_FIELDS) {
			for (const conflict of record.metadataConflicts?.[field] ?? []) add(field, conflict.value, conflict.sources);
		}
	}
	for (const field of METADATA_CONFLICT_FIELDS) {
		const leftValue = left[field];
		const rightValue = right[field];
		if (leftValue === undefined || rightValue === undefined) continue;
		if (normalizedMetadataValue(leftValue) === normalizedMetadataValue(rightValue)) continue;
		add(field, leftValue, metadataSources(left));
		add(field, rightValue, metadataSources(right));
	}
	return Object.keys(merged).length ? merged : undefined;
}

export function mergePaperRecords(left: PaperRecord, right: PaperRecord): PaperRecord {
	const identifiers = {
		...right.identifiers,
		...left.identifiers,
		doi: normalizeDoi(left.identifiers.doi) ?? normalizeDoi(right.identifiers.doi),
		arxivId: normalizeArxivId(left.identifiers.arxivId) ?? normalizeArxivId(right.identifiers.arxivId),
		openAlexId: left.identifiers.openAlexId ?? right.identifiers.openAlexId,
		semanticScholarId: left.identifiers.semanticScholarId ?? right.identifiers.semanticScholarId,
	};
	const links = uniquePaperLinks([...left.links, ...right.links]);
	const provenance = new Map<string, PaperRecord["provenance"][number]>();
	for (const item of [...left.provenance, ...right.provenance]) {
		const key = [item.provider, item.query, item.providerRecordId ?? "", item.rawUrl ?? ""].join("|");
		if (!provenance.has(key)) provenance.set(key, item);
	}
	// Clean before choosing so a dirty variant never wins the length comparison,
	// and so merging also repairs records that were already stored unclean.
	const leftTitle = cleanPaperTitle(left.title);
	const rightTitle = cleanPaperTitle(right.title);
	const leftAbstract = typeof left.abstract === "string" ? cleanPaperText(left.abstract) : undefined;
	const rightAbstract = typeof right.abstract === "string" ? cleanPaperText(right.abstract) : undefined;
	const merged: PaperRecord = {
		...right,
		...left,
		id: left.id,
		title:
			normalizeTitle(leftTitle) === normalizeTitle(rightTitle) &&
			hasLayoutSpacedTitlePrefix(leftTitle) !== hasLayoutSpacedTitlePrefix(rightTitle)
				? hasLayoutSpacedTitlePrefix(leftTitle)
					? rightTitle
					: leftTitle
				: leftTitle.length >= rightTitle.length
					? leftTitle
					: rightTitle,
		abstract: (leftAbstract?.length ?? 0) >= (rightAbstract?.length ?? 0) ? leftAbstract : rightAbstract,
		authors: left.authors.length >= right.authors.length ? left.authors : right.authors,
		year: left.year ?? right.year,
		venue: left.venue ?? right.venue,
		venueRank: left.venueRank ?? right.venueRank,
		publicationType: left.publicationType ?? right.publicationType,
		metadataConflicts: mergePaperMetadataConflicts(left, right),
		identifiers,
		links,
		materialHashes: uniqueStrings([...(left.materialHashes ?? []), ...(right.materialHashes ?? [])]),
		citationCount: Math.max(left.citationCount ?? 0, right.citationCount ?? 0) || undefined,
		referencedWorks: uniqueStrings([...(left.referencedWorks ?? []), ...(right.referencedWorks ?? [])]),
		citedByApiUrl: left.citedByApiUrl ?? right.citedByApiUrl,
		provenance: [...provenance.values()],
		discoveryPaths: uniqueDiscoveryPaths([...(left.discoveryPaths ?? []), ...(right.discoveryPaths ?? [])]),
		mergedFrom: uniqueStrings([...left.mergedFrom, ...right.mergedFrom, right.id]).filter((id) => id !== left.id),
		curation: mergeCuration(left.curation, right.curation),
		collectionIds: uniqueStrings([...(left.collectionIds ?? []), ...(right.collectionIds ?? [])]),
	};
	return merged;
}

export function deduplicatePaperRecords(records: PaperRecord[]): PaperRecord[] {
	const accepted = new Set<PaperRecord>();
	const byDoi = new Map<string, PaperRecord>();
	const byArxiv = new Map<string, PaperRecord>();
	const byOpenAlex = new Map<string, PaperRecord>();
	const bySemanticScholar = new Map<string, PaperRecord>();
	const byProviderRecord = new Map<string, PaperRecord>();
	const byMaterialHash = new Map<string, PaperRecord>();
	const byPdfUrl = new Map<string, PaperRecord>();
	const byTitleFirstAuthor = new Map<string, PaperRecord[]>();
	const rebuildIndexes = () => {
		byDoi.clear();
		byArxiv.clear();
		byOpenAlex.clear();
		bySemanticScholar.clear();
		byProviderRecord.clear();
		byMaterialHash.clear();
		byPdfUrl.clear();
		byTitleFirstAuthor.clear();
		for (const acceptedRecord of accepted) {
			const doi = normalizeDoi(acceptedRecord.identifiers.doi);
			const arxivId = normalizeArxivId(acceptedRecord.identifiers.arxivId);
			if (doi) byDoi.set(doi, acceptedRecord);
			if (arxivId) byArxiv.set(arxivId, acceptedRecord);
			if (acceptedRecord.identifiers.openAlexId) {
				byOpenAlex.set(acceptedRecord.identifiers.openAlexId.toLowerCase(), acceptedRecord);
			}
			if (acceptedRecord.identifiers.semanticScholarId) {
				bySemanticScholar.set(acceptedRecord.identifiers.semanticScholarId.toLowerCase(), acceptedRecord);
			}
			for (const item of acceptedRecord.provenance) {
				if (item.providerRecordId) {
					byProviderRecord.set(`${item.provider}:${item.providerRecordId}`.toLowerCase(), acceptedRecord);
				}
			}
			for (const materialHash of acceptedRecord.materialHashes ?? []) {
				byMaterialHash.set(materialHash.toLowerCase(), acceptedRecord);
			}
			for (const url of paperPdfUrls(acceptedRecord)) byPdfUrl.set(url, acceptedRecord);
			const metadataKey = titleFirstAuthorIdentityKey(acceptedRecord);
			if (metadataKey) {
				const bucket = byTitleFirstAuthor.get(metadataKey) ?? [];
				bucket.push(acceptedRecord);
				byTitleFirstAuthor.set(metadataKey, bucket);
			}
		}
	};
	for (const inputRecord of records) {
		const record: PaperRecord = {
			...inputRecord,
			identifiers: {
				...inputRecord.identifiers,
				doi: normalizeDoi(inputRecord.identifiers.doi),
				arxivId: normalizeArxivId(inputRecord.identifiers.arxivId),
			},
		};
		if (!record.id) record.id = paperRecordId(record);
		const matches = new Set<PaperRecord>();
		const doiMatch = record.identifiers.doi ? byDoi.get(record.identifiers.doi) : undefined;
		const arxivMatch = record.identifiers.arxivId ? byArxiv.get(record.identifiers.arxivId) : undefined;
		if (doiMatch) matches.add(doiMatch);
		if (arxivMatch) matches.add(arxivMatch);
		if (record.identifiers.openAlexId) {
			const match = byOpenAlex.get(record.identifiers.openAlexId.toLowerCase());
			if (match) matches.add(match);
		}
		if (record.identifiers.semanticScholarId) {
			const match = bySemanticScholar.get(record.identifiers.semanticScholarId.toLowerCase());
			if (match) matches.add(match);
		}
		for (const item of record.provenance) {
			if (!item.providerRecordId) continue;
			const match = byProviderRecord.get(`${item.provider}:${item.providerRecordId}`.toLowerCase());
			if (match) matches.add(match);
		}
		for (const materialHash of record.materialHashes ?? []) {
			const materialMatch = byMaterialHash.get(materialHash.toLowerCase());
			if (materialMatch) matches.add(materialMatch);
		}
		for (const url of paperPdfUrls(record)) {
			const pdfUrlMatch = byPdfUrl.get(url);
			if (pdfUrlMatch) matches.add(pdfUrlMatch);
		}
		if (matches.size === 0) {
			const metadataKey = titleFirstAuthorIdentityKey(record);
			const metadataMatches = metadataKey
				? (byTitleFirstAuthor.get(metadataKey) ?? []).filter((candidate) =>
						sameTitleAndFirstAuthor(candidate, record),
					)
				: [];
			if (metadataMatches.length === 1) matches.add(metadataMatches[0]);
		}
		let merged = record;
		for (const match of matches) {
			accepted.delete(match);
			merged = mergePaperRecords(match, merged);
		}
		accepted.add(merged);
		rebuildIndexes();
	}
	return [...accepted];
}

export function titleSimilarity(left: string, right: string): number {
	const leftTokens = new Set(normalizeTitle(left).split(" ").filter(Boolean));
	const rightTokens = new Set(normalizeTitle(right).split(" ").filter(Boolean));
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let intersection = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) intersection++;
	return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

export function findPossibleDuplicates(records: PaperRecord[], minimumSimilarity = 0.88): PossibleDuplicate[] {
	const buckets = new Map<string, PaperRecord[]>();
	const exactMetadataBuckets = new Map<string, PaperRecord[]>();
	const candidates: PossibleDuplicate[] = [];
	const comparedPairs = new Set<string>();
	const pairKey = (left: PaperRecord, right: PaperRecord): string => [left.id, right.id].sort().join("|");
	for (const record of records) {
		const metadataKey = titleFirstAuthorIdentityKey(record);
		if (metadataKey) {
			for (const prior of exactMetadataBuckets.get(metadataKey) ?? []) {
				if (prior.id === record.id) continue;
				if (!hasConflictingPrimaryIdentifiers(prior, record)) continue;
				comparedPairs.add(pairKey(prior, record));
				candidates.push({
					leftId: prior.id,
					rightId: record.id,
					titleSimilarity: 1,
					reason: "identity-conflict",
				});
			}
			const exactBucket = exactMetadataBuckets.get(metadataKey) ?? [];
			exactBucket.push(record);
			exactMetadataBuckets.set(metadataKey, exactBucket);
		}
		const titleTokens = normalizeTitle(record.title).split(" ").filter(Boolean);
		const author = normalizeFirstAuthorIdentity(record.authors[0]) || "unknown";
		const firstToken = titleTokens[0] ?? "untitled";
		const years = record.year === undefined ? ["unknown"] : [record.year - 1, record.year, record.year + 1];
		const compared = new Set<string>();
		for (const year of years) {
			for (const prior of buckets.get(`${author}|${firstToken}|${year}`) ?? []) {
				if (prior.id === record.id || compared.has(prior.id)) continue;
				compared.add(prior.id);
				if (comparedPairs.has(pairKey(prior, record))) continue;
				const similarity = titleSimilarity(prior.title, record.title);
				if (similarity >= minimumSimilarity) {
					comparedPairs.add(pairKey(prior, record));
					candidates.push({
						leftId: prior.id,
						rightId: record.id,
						titleSimilarity: similarity,
						reason: "similar-title",
					});
				}
			}
		}
		const ownKey = `${author}|${firstToken}|${record.year ?? "unknown"}`;
		const ownBucket = buckets.get(ownKey) ?? [];
		ownBucket.push(record);
		buckets.set(ownKey, ownBucket);
	}
	return candidates.sort(
		(left, right) =>
			right.titleSimilarity - left.titleSimilarity ||
			left.leftId.localeCompare(right.leftId) ||
			left.rightId.localeCompare(right.rightId),
	);
}
