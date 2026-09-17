import { normalizeArxivId, normalizeDoi, normalizeTitle, samePaperIdentity } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";

export interface SidebarSourceRef {
	search_run_id: string;
	paper_id: string;
}

export function sidebarSourceKey(ref: SidebarSourceRef): string {
	return JSON.stringify([ref.search_run_id, ref.paper_id]);
}

export function sidebarSourceRefs(meta: Record<string, unknown>): SidebarSourceRef[] {
	const refs: SidebarSourceRef[] = [];
	const seen = new Set<string>();
	const add = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const row = value as Record<string, unknown>;
		if (typeof row.search_run_id !== "string" || typeof row.paper_id !== "string") return;
		const ref = { search_run_id: row.search_run_id, paper_id: row.paper_id };
		const key = sidebarSourceKey(ref);
		if (seen.has(key)) return;
		seen.add(key);
		refs.push(ref);
	};
	add(meta);
	if (Array.isArray(meta.source_refs)) for (const ref of meta.source_refs) add(ref);
	return refs;
}

export function sidebarIdentity(
	left: PaperRecord,
	right: PaperRecord,
): "same" | "identity-conflict" | "same-title" | "different" {
	if (left.id === right.id) return "same";
	const leftDoi = normalizeDoi(left.identifiers.doi);
	const rightDoi = normalizeDoi(right.identifiers.doi);
	const leftArxiv = normalizeArxivId(left.identifiers.arxivId);
	const rightArxiv = normalizeArxivId(right.identifiers.arxivId);
	const conflicting = Boolean(
		(leftDoi && rightDoi && leftDoi !== rightDoi) || (leftArxiv && rightArxiv && leftArxiv !== rightArxiv),
	);
	if (samePaperIdentity(left, right)) return "same";
	const title = normalizeTitle(left.title);
	if (title && title === normalizeTitle(right.title)) {
		return conflicting ? "identity-conflict" : "same-title";
	}
	return "different";
}
