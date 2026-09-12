import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import { ResearchNotebook } from "../../research/application/research-notebook.ts";
import { WikiWorkspace } from "../../wiki/application/wiki-workspace.ts";

/** Locate absolute-looking paths so an explicit sharing preview can warn about retained references. */
export function absolutePathLocations(value: unknown, location = "$"): string[] {
	if (typeof value === "string") return /^([A-Za-z]:[\\/]|\/)/.test(value) ? [location] : [];
	if (Array.isArray(value))
		return value.flatMap((entry, index) => absolutePathLocations(entry, `${location}[${index}]`));
	if (value && typeof value === "object")
		return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
			absolutePathLocations(child, `${location}.${key}`),
		);
	return [];
}

/** Personal evidence adapters shared by the Web proposal flow and the Agent tool. */
export function createWikiWorkspaceForStore(
	dataRoot: string,
	namespace: string,
	store: LiteratureStore,
): WikiWorkspace {
	const notebook = new ResearchNotebook(store);
	return new WikiWorkspace(dataRoot, namespace, {
		resolvePaper: async (id) => {
			const record = await store.getPaper(id);
			if (!record) return undefined;
			const versions = await store.listPaperVersions(id);
			const preferred = versions.find((version) => version.isPreferred) ?? versions[0];
			return {
				kind: "paper",
				id,
				title: record.title,
				version: preferred?.sha256 ?? "metadata",
				updatedAt: preferred?.retrievedAt ?? record.curation?.reading?.updatedAt,
			};
		},
		resolveNote: async (id) => {
			const note = await notebook.get(id);
			return note
				? {
						kind: "note",
						id,
						title: note.title,
						version: note.contentHash,
						revision: note.revision,
						updatedAt: note.updatedAt,
					}
				: undefined;
		},
	});
}
