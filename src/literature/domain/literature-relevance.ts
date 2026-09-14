import { normalizeTitle } from "./literature-identifiers.ts";
import type { PaperRecord } from "./literature-types.ts";

// 多源检索的聚合结果原本按 provider 顺序整块拼接, 精确标题命中会被压到很后;
// 这里用查询 token 对标题/摘要的覆盖率做统一重排, 让精确命中的论文浮到最前。
const PREFIX_MIN_LENGTH = 4;
const PREFIX_MATCH_WEIGHT = 0.6;
const TITLE_WEIGHT = 0.75;
const ABSTRACT_WEIGHT = 0.25;

function tokenMatchWeight(token: string, targets: Set<string>): number {
	if (targets.has(token)) return 1;
	let best = 0;
	for (const target of targets) {
		const prefix = token.length <= target.length ? token : target;
		if (prefix.length >= PREFIX_MIN_LENGTH && (target.startsWith(token) || token.startsWith(target))) {
			best = Math.max(best, PREFIX_MATCH_WEIGHT);
		}
	}
	return best;
}

export function searchRelevanceScore(record: PaperRecord, queries: string[]): number {
	const normalizedRecordTitle = normalizeTitle(record.title);
	const titleTokens = new Set(normalizedRecordTitle.split(" ").filter(Boolean));
	const abstractTokens = new Set(
		normalizeTitle(record.abstract ?? "")
			.split(" ")
			.filter(Boolean),
	);
	let best = 0;
	for (const query of queries) {
		const normalizedQuery = normalizeTitle(query);
		if (normalizedQuery === normalizedRecordTitle) return 1;
		const queryTokens = normalizedQuery.split(" ").filter(Boolean);
		if (queryTokens.length === 0) continue;
		let titleMatches = 0;
		let abstractMatches = 0;
		for (const token of queryTokens) {
			titleMatches += tokenMatchWeight(token, titleTokens);
			abstractMatches += tokenMatchWeight(token, abstractTokens);
		}
		const score =
			(titleMatches / queryTokens.length) * TITLE_WEIGHT + (abstractMatches / queryTokens.length) * ABSTRACT_WEIGHT;
		best = Math.max(best, Math.min(1, score));
	}
	return best;
}

export function rerankByQueryRelevance(records: PaperRecord[], queries: string[]): PaperRecord[] {
	return records
		.map((record, index) => ({ record, index, score: searchRelevanceScore(record, queries) }))
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map((entry) => entry.record);
}
