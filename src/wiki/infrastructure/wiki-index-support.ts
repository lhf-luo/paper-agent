import type { WikiEvidence, WikiSearchOptions } from "../domain/wiki-types.ts";

export interface WikiRankRow {
	page_id: string;
	rank: number;
	snippet?: string;
	heading?: string;
}

export interface WikiNeighborRow {
	id: string;
	title: string;
	aliases_json: string;
}

export interface WikiLinkRow {
	source_page_id: string;
	target_title: string;
}

export function searchExpression(value: string): string | undefined {
	const terms = value
		.normalize("NFKC")
		.toLowerCase()
		.match(/[\p{L}\p{N}]+/gu);
	if (!terms?.length) return undefined;
	return [...new Set(terms)].map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
}

export function normalizeLabel(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseStrings(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

export function parseLocator(value: string): WikiEvidence["locator"] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as WikiEvidence["locator"])
			: {};
	} catch {
		return {};
	}
}

export function filtersSql(options: WikiSearchOptions): { sql: string; params: Array<string | number> } {
	const conditions: string[] = [];
	const params: Array<string | number> = [];
	if (options.pageId) {
		conditions.push("p.id = ?");
		params.push(options.pageId);
	}
	if (options.type && options.type !== "all") {
		conditions.push("p.page_type = ?");
		params.push(options.type);
	}
	if (options.status && options.status !== "all") {
		conditions.push("p.status = ?");
		params.push(options.status);
	}
	if (options.paperId) {
		conditions.push(`EXISTS (
			SELECT 1 FROM wiki_page_sources source
			WHERE source.namespace_id = p.namespace_id AND source.page_id = p.id
				AND (source.paper_id = ? OR (source.kind = 'paper' AND source.source_id = ?))
		)`);
		params.push(options.paperId, options.paperId);
	}
	if (options.noteId) {
		conditions.push(`EXISTS (
			SELECT 1 FROM wiki_page_sources source
			WHERE source.namespace_id = p.namespace_id AND source.page_id = p.id
				AND source.kind = 'note' AND source.source_id = ?
		)`);
		params.push(options.noteId);
	}
	return { sql: conditions.length ? ` AND ${conditions.join(" AND ")}` : "", params };
}

export function evidenceIdsFromText(value: string): string[] {
	return [...new Set([...value.matchAll(/\[(E[1-9]\d*)\]/g)].map((match) => match[1]))];
}

export function emptySync(pageCount: number) {
	return { pageCount, issues: [], indexedAt: new Date().toISOString() };
}

export function chunks(markdown: string): Array<{ heading?: string; content: string }> {
	const sections = markdown.split(/(?=^#{1,6}\s+)/m);
	return sections.flatMap((section) => {
		const heading = /^#{1,6}\s+(.+)$/m.exec(section)?.[1]?.trim();
		const values: Array<{ heading?: string; content: string }> = [];
		for (let offset = 0; offset < section.length; offset += 4_000) {
			values.push({ heading, content: section.slice(offset, offset + 4_000) });
		}
		return values;
	});
}
