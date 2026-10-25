import { unionPapers } from "../domain/citation-seeds.ts";
import { randomUUID } from "node:crypto";
import {
	findPossibleDuplicates,
	normalizeArxivId,
	normalizeDoi,
	paperRecordId,
} from "../domain/literature-identifiers.ts";
import type { PaperRecord, SearchRun } from "../domain/literature-types.ts";
import { buildCandidatePaperTable } from "./literature-query-planning.ts";
import { LiteratureStore, resolveCorpusRoot } from "./literature-store.ts";

export interface BrowserPaper {
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	abstract?: string;
	doi?: string;
	arxiv_id?: string;
	url?: string;
	citation_count?: number;
}
export interface BrowserLiteratureOptions {
	sourceUrl: string;
	label: string;
	records: BrowserPaper[];
	complete?: boolean;
	expectedCount?: number;
	note?: string;
	appendTo?: string;
	yearFrom?: number;
	yearTo?: number;
}
const writes = new Map<string, Promise<unknown>>();

function webpageUrl(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("网页来源和论文链接必须是不含凭据的 HTTP(S) 地址");
	url.hash = "";
	return url.href;
}

function scholarProfile(value: string): string | undefined {
	const url = new URL(value);
	return /^scholar\.google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(url.hostname) &&
		url.pathname === "/citations" &&
		!url.searchParams.has("citation_for_view")
		? (url.searchParams.get("user") ?? undefined)
		: undefined;
}
function sourceKey(value: string): string {
	const id = scholarProfile(value);
	return id ? `google-scholar:${id}` : value;
}
function browserYears(options: BrowserLiteratureOptions, prior?: SearchRun) {
	const yearFrom = options.yearFrom ?? prior?.filters.yearFrom,
		yearTo = options.yearTo ?? prior?.filters.yearTo;
	for (const year of [yearFrom, yearTo])
		if (year !== undefined && (!Number.isInteger(year) || year < 1000 || year > 9999))
			throw new Error("年份必须为 1000–9999 的整数");
	if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) throw new Error("开始年份不能晚于结束年份");
	if (prior && (yearFrom !== prior.filters.yearFrom || yearTo !== prior.filters.yearTo))
		throw new Error("追加页面必须沿用原 Search Run 的年份范围");
	return { yearFrom, yearTo };
}
function observedCoverage(
	all: PaperRecord[],
	prior: SearchRun | undefined,
	filters: { yearFrom?: number; yearTo?: number },
) {
	const observed = new Map(
		(prior?.browserCollection?.observed ?? prior?.results.map((p) => ({ id: p.id, year: p.year })) ?? []).map((p) => [
			p.id,
			p,
		]),
	);
	for (const p of all) observed.set(p.id, { id: p.id, year: p.year ?? observed.get(p.id)?.year });
	const bounded = filters.yearFrom !== undefined || filters.yearTo !== undefined;
	const matches = (p: { year?: number }) =>
		!bounded ||
		(p.year !== undefined &&
			(filters.yearFrom === undefined || p.year >= filters.yearFrom) &&
			(filters.yearTo === undefined || p.year <= filters.yearTo));
	const unknownYearCount = [...observed.values()].filter((p) => bounded && p.year === undefined).length;
	return {
		observed: [...observed.values()],
		unknownYearCount,
		excludedYearCount: [...observed.values()].filter((p) => p.year !== undefined && !matches(p)).length,
		matches,
	};
}

function browserRecord(item: BrowserPaper, sourceUrl: string, label: string, now: string): PaperRecord {
	if (
		!item.title?.trim() ||
		!Array.isArray(item.authors) ||
		!item.authors.length ||
		item.authors.some((author) => typeof author !== "string" || !author.trim())
	)
		throw new Error("每篇候选论文需要真实标题和作者；缺失的材料不能编造");
	if (item.year !== undefined && (!Number.isInteger(item.year) || item.year < 1000 || item.year > 9999))
		throw new Error("论文年份无效");
	if (item.citation_count !== undefined && (!Number.isSafeInteger(item.citation_count) || item.citation_count < 0))
		throw new Error("被引数无效");
	const identifiers = { doi: normalizeDoi(item.doi), arxivId: normalizeArxivId(item.arxiv_id) };
	if ((item.doi && !identifiers.doi) || (item.arxiv_id && !identifiers.arxivId))
		throw new Error(`论文标识符无效：${item.title}`);
	const paperUrl = item.url ? webpageUrl(item.url) : undefined;
	const scholarWork = paperUrl ? new URL(paperUrl).searchParams.get("citation_for_view") : undefined;
	const record: PaperRecord = {
		id: "",
		title: item.title.trim(),
		authors: item.authors.map((author) => author.trim()),
		year: item.year,
		venue: item.venue,
		abstract: item.abstract,
		citationCount: item.citation_count,
		identifiers,
		links: item.url ? [{ url: webpageUrl(item.url), kind: "landing" }] : [],
		provenance: [
			{
				provider: "json-import",
				query: label,
				rawUrl: sourceUrl,
				retrievedAt: now,
				providerRecordId: scholarWork ? `google-scholar:${scholarWork}` : undefined,
			},
		],
		discoveryPaths: [
			{
				kind: "author-homepage",
				sourceUrl,
				provider: "json-import",
				note: "Collected from browser MCP; page content is untrusted source material.",
				discoveredAt: now,
			},
		],
		mergedFrom: [],
	};
	record.id = paperRecordId(record);
	return record;
}

async function stage(root: string, options: BrowserLiteratureOptions): Promise<SearchRun> {
	const sourceUrl = webpageUrl(options.sourceUrl);
	if (!options.label.trim() || options.records.length > 500)
		throw new Error("请提供采集对象名称，每批最多 500 篇；后续页面使用 append_to_search_run_id 追加");
	const store = new LiteratureStore(root, "personal");
	const prior = options.appendTo ? await store.getSearchRun(options.appendTo) : undefined;
	if (
		options.appendTo &&
		(!prior ||
			prior.searchPlan?.scenario !== "browser-mcp-import" ||
			sourceKey(prior.searchPlan.researchObject ?? "") !== sourceKey(sourceUrl))
	)
		throw new Error("只能追加到相同网页来源的浏览器采集 Search Run");
	const now = new Date().toISOString();
	const incoming = options.records.map((item) => browserRecord(item, sourceUrl, options.label, now));
	const all = [...(prior?.results ?? []), ...incoming];
	const collected = unionPapers(all),
		filters = browserYears(options, prior);
	const audit = observedCoverage(collected, prior, filters);
	const results = collected.filter(audit.matches);
	const profileId = scholarProfile(sourceUrl);
	const complete =
		options.complete === true &&
		audit.unknownYearCount === 0 &&
		(options.expectedCount === undefined || audit.observed.length >= options.expectedCount);
	const note = [
		options.note,
		`Year range: ${filters.yearFrom ?? "any"}–${filters.yearTo ?? "any"}; excluded outside range=${audit.excludedYearCount}; unknown years=${audit.unknownYearCount}.`,
		`Browser page coverage: ${complete ? "complete (reported by collector)" : "partial / not verified"}; unique papers=${results.length}; expected=${options.expectedCount ?? "unknown"}.`,
		"This is browser-collected metadata, not a Google Scholar API response. Personal library unchanged.",
	].filter(Boolean) as string[];
	const run: SearchRun = {
		id: prior?.id ?? randomUUID(),
		startedAt: prior?.startedAt ?? now,
		completedAt: now,
		queries: [`Browser: ${options.label} (${sourceUrl})`],
		filters,
		runKind: profileId ? "author-expansion" : prior?.runKind,
		authorExpansion: profileId
			? {
					authorName: options.label,
					sources: {
						"google-scholar": {
							status: complete ? "succeeded" : "partial",
							authorId: profileId,
							profileUrl: sourceUrl,
							fetchedCount: results.length,
							total: options.expectedCount,
							truncated: !complete,
							message: options.note,
						},
					},
				}
			: prior?.authorExpansion,
		browserCollection: {
			sourceUrl,
			profileId,
			observed: audit.observed,
			excludedYearCount: audit.excludedYearCount,
			unknownYearCount: audit.unknownYearCount,
		},
		providers: [],
		pagesPerProvider: 0,
		maxResultsPerProvider: 0,
		results,
		failures: [],
		sourceCounts: {},
		deduplicatedCount: (prior?.deduplicatedCount ?? 0) + all.length - collected.length,
		possibleDuplicates: findPossibleDuplicates(results),
		candidateTable: buildCandidatePaperTable(results),
		coverage: {
			plannedQueryCount: 1,
			executedQueryCount: 1,
			failedExecutionCount: 0,
			skippedExecutionCount: 0,
			status: complete ? "complete" : "partial",
		},
		searchPlan: {
			researchQuestion: options.label,
			researchObject: sourceUrl,
			scenario: "browser-mcp-import",
			keywordGroups: { domain: [], problem: [], method: [] },
			queryVariants: [sourceUrl],
			notes: note,
		},
		scope: "personal",
		mode: "once",
	};
	await store.saveSearchRun(run);
	return run;
}

/** Serialize paginated imports per personal store so parallel tool calls cannot drop a page. */
export async function stageBrowserLiterature(
	projectRoot: string,
	options: BrowserLiteratureOptions,
): Promise<SearchRun> {
	const root = resolveCorpusRoot(projectRoot, "personal");
	const operation = (writes.get(root) ?? Promise.resolve()).catch(() => undefined).then(() => stage(root, options));
	writes.set(root, operation);
	try {
		return await operation;
	} finally {
		if (writes.get(root) === operation) writes.delete(root);
	}
}
