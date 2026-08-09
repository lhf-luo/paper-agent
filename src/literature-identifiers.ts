import { createHash } from "node:crypto";
import type { PaperCuration, PaperRecord, PossibleDuplicate } from "./literature-types.ts";

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

export function normalizeTitle(value: string): string {
	return value
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

export function paperDedupKey(
	record: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes">,
): string {
	const doi = normalizeDoi(record.identifiers.doi);
	if (doi) return "doi:" + doi;
	const arxivId = normalizeArxivId(record.identifiers.arxivId);
	if (arxivId) return "arxiv:" + arxivId;
	const materialHash = record.materialHashes?.find((value) => /^[a-f0-9]{64}$/i.test(value));
	if (materialHash) return "material:" + materialHash.toLowerCase();
	return "metadata:" + paperMetadataKey(record);
}

export function paperMetadataKey(record: Pick<PaperRecord, "title" | "authors" | "year">): string {
	return [normalizeTitle(record.title), normalizeAuthor(record.authors[0]), record.year ?? "unknown"].join(":");
}

export function samePaperIdentity(
	left: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes" | "provenance">,
	right: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes" | "provenance">,
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
	return false;
}

export function paperRecordId(
	record: Pick<PaperRecord, "title" | "authors" | "year" | "identifiers" | "materialHashes" | "provenance" | "links">,
): string {
	const doi = normalizeDoi(record.identifiers.doi);
	if (doi) return "doi-" + sha256Text(doi).slice(0, 20);
	const arxivId = normalizeArxivId(record.identifiers.arxivId);
	if (arxivId) return "arxiv-" + arxivId.replace(/[^a-z0-9]+/gi, "-");
	const materialHash = record.materialHashes?.find((value) => /^[a-f0-9]{64}$/i.test(value));
	if (materialHash) return "material-" + materialHash.slice(0, 20).toLowerCase();
	const sourceIdentity =
		record.provenance
			.map((item) => [item.provider, item.providerRecordId ?? "", item.rawUrl ?? ""].join(":"))
			.find((value) => !value.endsWith("::")) ??
		record.links.map((link) => link.url).sort()[0] ??
		"source-unknown";
	return "paper-" + sha256Text(`${paperMetadataKey(record)}:${sourceIdentity}`).slice(0, 20);
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

export function mergePaperRecords(left: PaperRecord, right: PaperRecord): PaperRecord {
	const identifiers = {
		doi: normalizeDoi(left.identifiers.doi) ?? normalizeDoi(right.identifiers.doi),
		arxivId: normalizeArxivId(left.identifiers.arxivId) ?? normalizeArxivId(right.identifiers.arxivId),
		openAlexId: left.identifiers.openAlexId ?? right.identifiers.openAlexId,
		semanticScholarId: left.identifiers.semanticScholarId ?? right.identifiers.semanticScholarId,
	};
	const links = new Map<string, PaperRecord["links"][number]>();
	for (const link of [...left.links, ...right.links]) {
		if (!links.has(link.url)) links.set(link.url, link);
	}
	const provenance = new Map<string, PaperRecord["provenance"][number]>();
	for (const item of [...left.provenance, ...right.provenance]) {
		const key = [item.provider, item.query, item.providerRecordId ?? "", item.rawUrl ?? ""].join("|");
		if (!provenance.has(key)) provenance.set(key, item);
	}
	const merged: PaperRecord = {
		id: left.id,
		title: left.title.length >= right.title.length ? left.title : right.title,
		abstract: (left.abstract?.length ?? 0) >= (right.abstract?.length ?? 0) ? left.abstract : right.abstract,
		authors: left.authors.length >= right.authors.length ? left.authors : right.authors,
		year: left.year ?? right.year,
		venue: left.venue ?? right.venue,
		publicationType: left.publicationType ?? right.publicationType,
		identifiers,
		links: [...links.values()],
		materialHashes: uniqueStrings([...(left.materialHashes ?? []), ...(right.materialHashes ?? [])]),
		citationCount: Math.max(left.citationCount ?? 0, right.citationCount ?? 0) || undefined,
		referencedWorks: uniqueStrings([...(left.referencedWorks ?? []), ...(right.referencedWorks ?? [])]),
		citedByApiUrl: left.citedByApiUrl ?? right.citedByApiUrl,
		provenance: [...provenance.values()],
		mergedFrom: uniqueStrings([...left.mergedFrom, ...right.mergedFrom, left.id, right.id]),
		curation: mergeCuration(left.curation, right.curation),
	};
	merged.id = paperRecordId(merged);
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
	const rebuildIndexes = () => {
		byDoi.clear();
		byArxiv.clear();
		byOpenAlex.clear();
		bySemanticScholar.clear();
		byProviderRecord.clear();
		byMaterialHash.clear();
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
		}
	};
	for (const record of records) {
		record.identifiers.doi = normalizeDoi(record.identifiers.doi);
		record.identifiers.arxivId = normalizeArxivId(record.identifiers.arxivId);
		record.id = paperRecordId(record);
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
	const candidates: PossibleDuplicate[] = [];
	for (const record of records) {
		const titleTokens = normalizeTitle(record.title).split(" ").filter(Boolean);
		const author = normalizeAuthor(record.authors[0]) || "unknown";
		const firstToken = titleTokens[0] ?? "untitled";
		const years = record.year === undefined ? ["unknown"] : [record.year - 1, record.year, record.year + 1];
		const compared = new Set<string>();
		for (const year of years) {
			for (const prior of buckets.get(`${author}|${firstToken}|${year}`) ?? []) {
				if (prior.id === record.id || compared.has(prior.id)) continue;
				compared.add(prior.id);
				const similarity = titleSimilarity(prior.title, record.title);
				if (similarity >= minimumSimilarity) {
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
