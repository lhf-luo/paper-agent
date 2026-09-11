import type { Abortable } from "node:events";
import {
	type DoiEnrichmentResult,
	enrichRecordsByDoi,
	type DoiProviderLookup,
} from "./literature-doi-enrichment.ts";
import {
	resolveSidebarSelection,
	type SidebarSelectionResolution,
} from "./literature-sidebar.ts";
import type { LiteratureStore } from "./literature-store.ts";
import type { PaperRecord } from "../domain/literature-types.ts";

export interface PreparedSidebarSelection {
	resolution: SidebarSelectionResolution;
	records: PaperRecord[];
	enrichment: Omit<DoiEnrichmentResult, "records">;
}

export async function prepareSidebarSelection(
	source: LiteratureStore,
	cwd: string,
	resultUrl: string,
	paperIds?: string[],
	options: Abortable & { lookup?: DoiProviderLookup } = {},
): Promise<PreparedSidebarSelection> {
	const resolution = await resolveSidebarSelection(source, cwd, resultUrl, paperIds);
	if (!resolution.records.length) throw new Error("No search-backed papers were found in the literature list");
	const enriched = await enrichRecordsByDoi(
		resolution.records.map((item) => item.record),
		cwd,
		options,
	);
	return {
		resolution,
		records: enriched.records,
		enrichment: {
			attempts: enriched.attempts,
			warnings: enriched.warnings,
			skippedWithoutDoi: enriched.skippedWithoutDoi,
			skippedComplete: enriched.skippedComplete,
		},
	};
}

export function assignCollection(records: PaperRecord[], collectionId?: string): PaperRecord[] {
	if (!collectionId) return records;
	return records.map((record) => ({
		...record,
		collectionIds: Array.from(new Set([...(record.collectionIds ?? []), collectionId])),
	}));
}

export function sidebarFocusGroups(resolution: SidebarSelectionResolution): Record<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const item of resolution.records) {
		const focus = item.focus?.trim() || "未分类";
		const ids = groups.get(focus) ?? [];
		ids.push(item.record.id);
		groups.set(focus, ids);
	}
	return Object.fromEntries(groups);
}
