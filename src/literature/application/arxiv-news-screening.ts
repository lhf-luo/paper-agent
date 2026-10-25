import type { PaperRecord } from "../domain/literature-types.ts";
import { type FilterGroupOptions, type FilterRuleOptions, filterGroup } from "./literature-filtering.ts";

export { DEFAULT_NEWS_FILTER_GROUPS, validateNewsFilterGroups } from "../domain/arxiv-news-rules.ts";
export type { NewsFilterRule, NewsFilterGroup } from "../domain/arxiv-news-rules.ts";
import type { NewsFilterRule, NewsFilterGroup } from "../domain/arxiv-news-rules.ts";

function toFilterRule(input: NewsFilterRule): FilterRuleOptions {
	return {
		includeTerms: input.include_terms,
		includeTermGroups: input.include_term_groups,
		excludeTerms: input.exclude_terms,
		excludeScope: input.exclude_scope,
		yearFrom: input.year_from,
		yearTo: input.year_to,
		venueRank: input.venue_rank,
	};
}

export interface NewsScreening {
	matchedIds: string[];
	unresolvedIds: string[];
	labelsByPaper: Record<string, string[]>;
	filteredCount: number;
}

export function screenNewsPapers(papers: PaperRecord[], groups: NewsFilterGroup[]): NewsScreening {
	const matched = new Set<string>();
	const unresolved = new Set<string>();
	const labelsByPaper: Record<string, string[]> = {};
	for (const [index, group] of groups.entries()) {
		const options: FilterGroupOptions = {
			label: group.label,
			withAbstract: toFilterRule(group.with_abstract),
			withoutAbstract: toFilterRule(group.without_abstract),
		};
		const result = filterGroup(papers, options);
		for (const entry of result.matched) {
			matched.add(entry.record.id);
			unresolved.delete(entry.record.id);
			if (!labelsByPaper[entry.record.id]) labelsByPaper[entry.record.id] = [];
			labelsByPaper[entry.record.id].push(group.label ?? `规则 ${index + 1}`);
		}
		for (const entry of result.unresolved) {
			if (!matched.has(entry.record.id)) unresolved.add(entry.record.id);
			if (!labelsByPaper[entry.record.id]) labelsByPaper[entry.record.id] = [];
			labelsByPaper[entry.record.id].push(group.label ?? `规则 ${index + 1}`);
		}
	}
	return {
		matchedIds: [...matched],
		unresolvedIds: [...unresolved],
		labelsByPaper,
		filteredCount: papers.length - matched.size - unresolved.size,
	};
}
