import type { LiteratureStore } from "../../../literature/application/literature-store.ts";
import { normalizeDoi } from "../../../literature/domain/literature-identifiers.ts";
import type { PaperRecord } from "../../../literature/domain/literature-types.ts";
import { identifierConflict, matchesTitleAndAuthor, paperRecordFromZotero } from "../domain/zotero-mapping.ts";
import type { ZoteroApiItem, ZoteroItemMapping } from "../domain/zotero-types.ts";

export function validSelection(values: unknown, label: string): string[] {
	if (values === undefined) return [];
	if (!Array.isArray(values) || values.length > 1_000 || !values.every((value) => typeof value === "string")) {
		throw new Error(`${label} must be an array of at most 1000 ids`);
	}
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function descendantKeys(collections: Array<{ key: string; parentKey?: string }>, roots: string[]): Set<string> {
	const selected = new Set(roots);
	let changed = true;
	while (changed) {
		changed = false;
		for (const collection of collections) {
			if (collection.parentKey && selected.has(collection.parentKey) && !selected.has(collection.key)) {
				selected.add(collection.key);
				changed = true;
			}
		}
	}
	return selected;
}

export function collectionKeysWithAncestors(
	collections: Array<{ key: string; parentKey?: string }>,
	keys: Iterable<string>,
): Set<string> {
	const byKey = new Map(collections.map((collection) => [collection.key, collection]));
	const result = new Set<string>();
	for (const key of keys) {
		let current = byKey.get(key);
		const seen = new Set<string>();
		while (current && !seen.has(current.key)) {
			seen.add(current.key);
			result.add(current.key);
			current = current.parentKey ? byKey.get(current.parentKey) : undefined;
		}
	}
	return result;
}

export async function matchPersonalPaper(
	store: LiteratureStore,
	item: ZoteroApiItem,
	serverId: string,
	mappings: ZoteroItemMapping[],
	pdfSha256?: string,
): Promise<{ record: PaperRecord; existing?: PaperRecord; conflict?: string }> {
	const record = paperRecordFromZotero(item, serverId);
	const records = await store.listPapers();
	const mappedId = mappings.find((mapping) => mapping.itemKey === item.key)?.paperId;
	let existing =
		(mappedId ? records.find((candidate) => candidate.id === mappedId) : undefined) ??
		(record.identifiers.doi
			? records.find((candidate) => normalizeDoi(candidate.identifiers.doi) === normalizeDoi(record.identifiers.doi))
			: undefined) ??
		(record.identifiers.arxivId
			? records.find(
					(candidate) =>
						candidate.identifiers.arxivId?.toLowerCase() === record.identifiers.arxivId?.toLowerCase(),
				)
			: undefined) ??
		(pdfSha256 ? records.find((candidate) => candidate.materialHashes?.includes(pdfSha256)) : undefined);
	if (!existing && pdfSha256) {
		for (const candidate of records) {
			if ((await store.listPaperVersions(candidate.id)).some((version) => version.sha256 === pdfSha256)) {
				existing = candidate;
				break;
			}
		}
	}
	existing ??= records.find((candidate) => matchesTitleAndAuthor(candidate, record));
	return { record, existing, conflict: existing ? identifierConflict(existing, record) : undefined };
}
