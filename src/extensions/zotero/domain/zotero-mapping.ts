import { createHash } from "node:crypto";
import { normalizeDoi, normalizeTitle, uniquePaperLinks } from "../../../literature/domain/literature-identifiers.ts";
import type { PaperCollection, PaperRecord, PaperVersion } from "../../../literature/domain/literature-types.ts";
import type { ZoteroApiItem, ZoteroCollectionEntry, ZoteroCreator, ZoteroItemData } from "./zotero-types.ts";

const internalTags = new Set(["needs-skim-card"]);

export function creatorName(creator: ZoteroCreator): string {
	return creator.name?.trim() || [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim();
}

export function zoteroAuthors(data: ZoteroItemData): string[] {
	return (data.creators ?? [])
		.filter((creator) => !creator.creatorType || ["author", "inventor", "programmer"].includes(creator.creatorType))
		.map(creatorName)
		.filter(Boolean);
}

export function zoteroYear(data: ZoteroItemData): number | undefined {
	const match = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(data.date ?? "");
	return match ? Number(match[1]) : undefined;
}

export function arxivFromExtra(extra?: string): string | undefined {
	return /(?:arxiv(?:\s+id)?\s*[:=]\s*|arxiv\.org\/(?:abs|pdf)\/)([\w.-]+(?:v\d+)?)/i.exec(extra ?? "")?.[1];
}

export function publicationTypeFromZotero(itemType: string): string {
	const mapping: Record<string, string> = {
		journalArticle: "journal-article",
		conferencePaper: "conference-paper",
		preprint: "preprint",
		thesis: "thesis",
		book: "book",
		bookSection: "book-chapter",
		report: "report",
	};
	return mapping[itemType] ?? itemType;
}

export function zoteroItemType(publicationType?: string): string {
	const mapping: Record<string, string> = {
		"journal-article": "journalArticle",
		"conference-paper": "conferencePaper",
		preprint: "preprint",
		thesis: "thesis",
		book: "book",
		"book-chapter": "bookSection",
		report: "report",
	};
	return mapping[publicationType ?? ""] ?? "journalArticle";
}

function yearFromDate(value?: string): number | undefined {
	const year = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(value ?? "")?.[1];
	return year ? Number(year) : undefined;
}

export function paperRecordFromZotero(item: ZoteroApiItem, serverId: string): PaperRecord {
	const data = item.data;
	const authors = zoteroAuthors(data);
	const doi = normalizeDoi(data.DOI);
	const arxivId = arxivFromExtra(data.extra);
	const links = uniquePaperLinks(
		[
			...(doi ? [{ url: `https://doi.org/${doi}`, kind: "doi" as const }] : []),
			...(data.url?.trim() ? [{ url: data.url.trim(), kind: "landing" as const }] : []),
		].filter((value) => Boolean(value.url)),
	);
	return {
		id: `zotero-${createHash("sha256").update(`${serverId}:${item.key}`).digest("hex").slice(0, 20)}`,
		title: data.title?.trim() ?? "",
		authors,
		abstract: data.abstractNote?.trim() || undefined,
		year: yearFromDate(data.date),
		venue: data.publicationTitle?.trim() || data.conferenceName?.trim() || data.proceedingsTitle?.trim() || undefined,
		publicationType: publicationTypeFromZotero(data.itemType),
		identifiers: { doi, arxivId },
		links,
		provenance: [
			{
				provider: "zotero",
				query: `local-item:${item.key}`,
				retrievedAt: new Date().toISOString(),
				providerRecordId: item.key,
			},
		],
		mergedFrom: [],
		curation: {
			tags: (data.tags ?? []).map((tag) => tag.tag.trim()).filter(Boolean),
			userNotes: [],
		},
	};
}

function normalizedAuthor(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

export function matchesTitleAndAuthor(left: PaperRecord, right: PaperRecord): boolean {
	if (normalizeTitle(left.title) !== normalizeTitle(right.title)) return false;
	const rightAuthors = new Set(right.authors.map(normalizedAuthor));
	return left.authors.some((author) => rightAuthors.has(normalizedAuthor(author)));
}

export function identifierConflict(left: PaperRecord, right: PaperRecord): string | undefined {
	const leftDoi = normalizeDoi(left.identifiers.doi);
	const rightDoi = normalizeDoi(right.identifiers.doi);
	if (leftDoi && rightDoi && leftDoi !== rightDoi) return `DOI 冲突：${leftDoi} / ${rightDoi}`;
	const leftArxiv = left.identifiers.arxivId?.toLowerCase();
	const rightArxiv = right.identifiers.arxivId?.toLowerCase();
	if (leftArxiv && rightArxiv && leftArxiv !== rightArxiv) return `arXiv ID 冲突：${leftArxiv} / ${rightArxiv}`;
	return undefined;
}

export function mergeZoteroIntoPersonal(target: PaperRecord, source: PaperRecord): PaperRecord {
	return {
		...target,
		title: source.title || target.title,
		authors: source.authors.length ? source.authors : target.authors,
		abstract: source.abstract || target.abstract,
		year: source.year ?? target.year,
		venue: source.venue || target.venue,
		publicationType: source.publicationType || target.publicationType,
		identifiers: {
			...target.identifiers,
			...Object.fromEntries(Object.entries(source.identifiers).filter(([, value]) => value)),
		},
		links: uniquePaperLinks([...target.links, ...source.links]),
		provenance: [...target.provenance, ...source.provenance],
		curation: {
			...(target.curation ?? { tags: [], userNotes: [] }),
			tags: [...new Set([...(target.curation?.tags ?? []), ...(source.curation?.tags ?? [])])],
			userNotes: target.curation?.userNotes ?? [],
		},
	};
}

export function paperToZoteroData(
	record: PaperRecord,
	template: ZoteroItemData,
	collectionKeys: string[],
): ZoteroItemData {
	const personalTags = (record.curation?.tags ?? [])
		.filter((tag) => !internalTags.has(tag.toLowerCase()))
		.map((tag) => ({ tag }));
	const data: ZoteroItemData = {
		...template,
		itemType: template.itemType,
		title: record.title,
		creators: record.authors.map((name) => ({ creatorType: "author", name })),
		collections: [...new Set([...(template.collections ?? []), ...collectionKeys])],
		tags: [
			...new Map([...(template.tags ?? []), ...personalTags].map((tag) => [tag.tag.toLowerCase(), tag])).values(),
		],
	};
	if (record.abstract) data.abstractNote = record.abstract;
	if (record.year) data.date = String(record.year);
	if (record.venue) {
		if (data.itemType === "conferencePaper") data.conferenceName = record.venue;
		else data.publicationTitle = record.venue;
	}
	if (record.identifiers.doi) data.DOI = normalizeDoi(record.identifiers.doi);
	if (record.identifiers.arxivId && !arxivFromExtra(String(data.extra ?? ""))) {
		data.extra = [String(data.extra ?? "").trim(), `arXiv: ${record.identifiers.arxivId}`].filter(Boolean).join("\n");
	}
	const url = record.links.find((link) => link.kind === "landing")?.url;
	if (url) data.url = url;
	return data;
}

export function collectionPathsForPaper(record: PaperRecord, collections: PaperCollection[]): PaperCollection[][] {
	const byId = new Map(collections.map((collection) => [collection.id, collection]));
	return (record.collectionIds ?? []).flatMap((id) => {
		const path: PaperCollection[] = [];
		const seen = new Set<string>();
		let current = byId.get(id);
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			path.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path.length ? [path] : [];
	});
}

export function preferredVersion(versions: PaperVersion[]): PaperVersion | undefined {
	const rank = (value: PaperVersion) => {
		if (value.isPreferred) return -1;
		return { published: 0, preprint: 1, unknown: 2, translation: 3, supplement: 4 }[value.versionKind ?? "unknown"];
	};
	return [...versions].sort(
		(left, right) => rank(left) - rank(right) || right.retrievedAt.localeCompare(left.retrievedAt),
	)[0];
}

export function zoteroCollectionPaths(items: ZoteroCollectionEntry[], keys: string[]): string[][] {
	const byKey = new Map(items.map((item) => [item.key, item]));
	return keys.map((key) => byKey.get(key)?.path).filter((path): path is string[] => Boolean(path));
}
