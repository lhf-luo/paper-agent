import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 最近 Agent/工具搜索运行日志的保留条数上限 */
const SEARCH_RUN_JOURNAL_LIMIT = 50;

async function appendSearchRunJournal(run: SearchRun, cwd: string): Promise<void> {
	try {
		const dir = join(cwd, ".paper-agent");
		const journal = join(dir, "search-runs.jsonl");
		await mkdir(dir, { recursive: true });
		const entry = `${JSON.stringify({ id: run.id, run })}\n`;
		let lines: string[] = [];
		try {
			const raw = await readFile(journal, "utf8");
			lines = raw.split(/\n/).filter((line) => line.trim());
		} catch {
			// 日志文件尚不存在, 从空开始。
		}
		lines.push(entry.trimEnd());
		if (lines.length > SEARCH_RUN_JOURNAL_LIMIT) {
			lines = lines.slice(lines.length - SEARCH_RUN_JOURNAL_LIMIT);
		}
		await writeFile(journal, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
	} catch {
		// 日志写入是尽力而为, 不影响搜索本身。
	}
}
import { requestInteractiveOperationAuthorization } from "./interactive-operation-consent.ts";
import { readableErrorMessage } from "./network-security.ts";
import { downloadLiteraturePdfs, literaturePdfDownloadPlan } from "./literature-download.ts";
import { deduplicatePaperRecords, findPossibleDuplicates, sha256Text } from "./literature-identifiers.ts";
import {
	fetchOpenAlexWorks,
	LiteratureProviderHttpError,
	searchOpenAlexCitations,
	searchProviderPage,
	searchSemanticScholarCitations,
} from "./literature-providers.ts";
import { LiteratureSearchCheckpoint } from "./literature-search-checkpoint.ts";
import { derivedCacheKey, LiteratureStore, resolveCorpusRoot } from "./literature-store.ts";
import type {
	CorpusScope,
	DerivedRecord,
	LiteratureProvider,
	PaperRecord,
	PersistenceMode,
	ProviderFailure,
	ScreeningStatus,
	SearchFilters,
	SearchRun,
} from "./literature-types.ts";
import {
	corpusUpsertPlan,
	derivedRecordWritePlan,
	persistDerivedRecord,
	persistPaperRecords,
	runAuthorizedMutation,
} from "./literature-write.ts";
import {
	type OperationAuthorization,
	OperationConsentManager,
	type OperationPlan,
	requestOperationAuthorization,
} from "./operation-consent.ts";

const providerSchema = Type.Union([
	Type.Literal("arxiv"),
	Type.Literal("openalex"),
	Type.Literal("crossref"),
	Type.Literal("semanticscholar"),
	Type.Literal("dblp"),
	Type.Literal("pubmed"),
	Type.Literal("core"),
	Type.Literal("opencitations"),
	Type.Literal("unpaywall"),
]);
const scopeSchema = Type.Union([Type.Literal("personal"), Type.Literal("team")]);
const modeSchema = Type.Union([Type.Literal("once"), Type.Literal("persistent")]);

export interface CollectLiteratureOptions {
	queries: string[];
	providers: LiteratureProvider[];
	filters: SearchFilters;
	pagesPerProvider: number;
	maxResultsPerProvider: number;
	scope: CorpusScope;
	mode: PersistenceMode;
	namespace: string;
	cwd: string;
	corpusRoot?: string;
	refreshCache?: boolean;
	reuseCorpus?: boolean;
	corpusOnly?: boolean;
	signal?: AbortSignal;
	authorization?: OperationAuthorization;
	checkpointPath?: string;
	providerPageSearch?: typeof searchProviderPage;
}

interface CollectionResult {
	run: SearchRun;
	cached: boolean;
	corpusPath?: string;
	persistenceCounts?: { created: number; updated: number; unchanged: number };
}

export function collectionPersistencePlan(options: CollectLiteratureOptions): OperationPlan {
	const root = resolveCorpusRoot(options.cwd, options.scope, options.namespace, options.corpusRoot);
	return {
		kind: "personal-corpus-write",
		summary: `Persist a literature search in ${options.scope}/${options.namespace}`,
		targets: [{ label: "corpus", value: root, risk: options.scope === "team" ? "high" : "medium" }],
		details: {
			queries: uniqueQueries(options.queries),
			providers: [...options.providers].sort(),
			filters: options.filters,
			pagesPerProvider: options.pagesPerProvider,
			maxResultsPerProvider: options.maxResultsPerProvider,
			scope: options.scope,
			namespace: options.namespace,
			corpusRoot: root,
		},
	};
}

type CorpusExportFormat = "markdown" | "csv" | "bibtex" | "json";

function corpusExportFilename(format: CorpusExportFormat, requested?: string): string {
	const extension = format === "markdown" ? "md" : format === "bibtex" ? "bib" : format;
	const filename = requested?.trim() || `literature-${Date.now()}.${extension}`;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(filename)) {
		throw new Error("filename must use 1-64 letters, numbers, dots, underscores, or hyphens");
	}
	return filename;
}

export function corpusExportPlan(
	store: LiteratureStore,
	format: CorpusExportFormat,
	filename: string,
	records: PaperRecord[],
): OperationPlan {
	const normalized = [...records].sort((left, right) => left.id.localeCompare(right.id));
	return {
		kind: "personal-corpus-write",
		summary: `Export ${normalized.length} literature records as ${format}`,
		targets: [{ label: "export-file", value: join(store.root, "exports", filename), risk: "low" }],
		details: {
			format,
			filename,
			recordIds: normalized.map((record) => record.id),
			recordsFingerprint: sha256Text(JSON.stringify(normalized)),
			corpusPath: store.root,
			scope: store.scope,
			namespace: store.namespace,
		},
	};
}

interface CorpusAnnotationInput {
	author: string;
	tags?: string[];
	note?: string;
	screeningStatus?: ScreeningStatus;
	screeningReason?: string;
}

export function corpusAnnotationPlan(
	store: LiteratureStore,
	records: PaperRecord[],
	input: CorpusAnnotationInput,
): OperationPlan {
	const recordIds = records.map((record) => record.id).sort();
	return {
		kind: "personal-corpus-write",
		summary: `Annotate ${recordIds.length} personal literature record(s)`,
		actor: input.author,
		targets: recordIds.map((id) => ({ label: "personal-paper", value: id, risk: "medium" })),
		details: {
			corpusPath: store.root,
			namespace: store.namespace,
			recordIds,
			recordsFingerprint: sha256Text(
				JSON.stringify([...records].sort((left, right) => left.id.localeCompare(right.id))),
			),
			annotation: input,
		},
	};
}

export function corpusTeamReviewPlan(
	store: LiteratureStore,
	records: PaperRecord[],
	decision: "team-approved" | "team-rejected",
	reviewer: string,
	reason?: string,
): OperationPlan {
	const recordIds = records.map((record) => record.id).sort();
	return {
		kind: "team-review",
		summary: `${decision === "team-approved" ? "Approve" : "Reject"} ${recordIds.length} local team proposal(s)`,
		actor: reviewer,
		targets: recordIds.map((id) => ({ label: "team-paper", value: id, risk: "high" })),
		details: {
			corpusPath: store.root,
			namespace: store.namespace,
			recordIds,
			recordsFingerprint: sha256Text(
				JSON.stringify([...records].sort((left, right) => left.id.localeCompare(right.id))),
			),
			decision,
			reason,
		},
	};
}

export function corpusPromotionPlan(
	source: LiteratureStore,
	target: LiteratureStore,
	records: PaperRecord[],
	contributor: string,
): OperationPlan {
	const normalized = [...records].sort((left, right) => left.id.localeCompare(right.id));
	return {
		kind: "team-proposal",
		summary: `Propose ${normalized.length} personal literature record(s) to the local team corpus`,
		actor: contributor,
		targets: normalized.map((record) => ({ label: record.title.slice(0, 120), value: record.id, risk: "high" })),
		details: {
			sourcePath: source.root,
			targetPath: target.root,
			sourceNamespace: source.namespace,
			targetNamespace: target.namespace,
			recordIds: normalized.map((record) => record.id),
			recordsFingerprint: sha256Text(JSON.stringify(normalized)),
			privacy: "Personal notes and screening decisions are removed by the team proposal write path.",
		},
	};
}

function uniqueQueries(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim().replace(/\s+/g, " ");
		const key = normalized.toLowerCase();
		if (!normalized || seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	if (result.length === 0) throw new Error("At least one non-empty query is required");
	if (result.length > 12) throw new Error("At most 12 query variants are allowed per collection run");
	return result;
}

const queryEquivalences: Array<[string, string]> = [
	["artificial intelligence", "AI"],
	["machine learning", "ML"],
	["deep learning", "DL"],
	["large language model", "LLM"],
	["natural language processing", "NLP"],
	["reinforcement learning", "RL"],
	["retrieval augmented generation", "RAG"],
	["software engineering", "SE"],
	["internet of things", "IoT"],
];

export function expandLiteratureQueries(primary: string, explicit: string[] = []): string[] {
	const generated = [primary, ...explicit];
	const normalizedPrimary = primary.trim().replace(/\s+/g, " ");
	const dehyphenated = normalizedPrimary.replace(/(?<=\p{L})-(?=\p{L})/gu, " ");
	if (dehyphenated !== normalizedPrimary) generated.push(dehyphenated);
	for (const [phrase, acronym] of queryEquivalences) {
		const phrasePattern = new RegExp(`\\b${phrase.replaceAll(" ", "\\s+")}\\b`, "i");
		const acronymPattern = new RegExp(`\\b${acronym}\\b`, "i");
		if (phrasePattern.test(normalizedPrimary)) generated.push(normalizedPrimary.replace(phrasePattern, acronym));
		else if (acronymPattern.test(normalizedPrimary))
			generated.push(normalizedPrimary.replace(acronymPattern, phrase));
	}
	return uniqueQueries(generated).slice(0, 12);
}

function isSearchRun(value: unknown): value is SearchRun {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as SearchRun).results) &&
		Array.isArray((value as SearchRun).queries) &&
		typeof (value as SearchRun).id === "string"
	);
}

function failureIsRetryable(message: string): boolean {
	return /\b(?:408|425|429|5\d\d)\b|timed?\s*out|temporar|network/i.test(message);
}

function hasClientSideFilters(provider: LiteratureProvider, filters: SearchFilters): boolean {
	if (provider === "arxiv" || provider === "semanticscholar") {
		return Object.values(filters).some((value) => value !== undefined && (!Array.isArray(value) || value.length > 0));
	}
	if (provider === "openalex")
		return Boolean(filters.venues?.length || filters.authors?.length || filters.types?.length);
	if (provider === "dblp" || provider === "pubmed" || provider === "core") {
		return Object.values(filters).some((value) => value !== undefined && (!Array.isArray(value) || value.length > 0));
	}
	return Boolean(filters.venues?.length || filters.authors?.length || filters.types?.length || filters.openAccess);
}

export async function collectLiterature(options: CollectLiteratureOptions): Promise<CollectionResult> {
	if (options.scope === "team" && options.mode === "persistent") {
		throw new Error(
			"Direct persistent writes to a team corpus are disabled; collect into personal scope, then promote",
		);
	}
	const queries = uniqueQueries(options.queries);
	if (options.mode === "persistent") {
		if (!options.authorization) {
			throw new Error("Persistent collection requires a user confirmation grant");
		}
		await options.authorization.manager.consume(options.authorization.grant, collectionPersistencePlan(options));
	}
	const normalizedSearchConfig = {
		queries,
		providers: [...options.providers].sort(),
		filters: options.filters,
		pagesPerProvider: options.pagesPerProvider,
		maxResultsPerProvider: options.maxResultsPerProvider,
		corpusOnly: options.corpusOnly ?? false,
	};
	const queryFingerprint = sha256Text(JSON.stringify(normalizedSearchConfig));
	const providerPageSearch = options.providerPageSearch ?? searchProviderPage;
	const checkpoint = options.checkpointPath
		? await LiteratureSearchCheckpoint.open(options.checkpointPath, queryFingerprint)
		: undefined;
	const cacheKey = derivedCacheKey({
		inputHashes: [queryFingerprint],
		operation: "literature-search",
		pipelineVersion: "3",
		normalizedConfig: normalizedSearchConfig,
	});
	const root = resolveCorpusRoot(options.cwd, options.scope, options.namespace, options.corpusRoot);
	const corpusStore = new LiteratureStore(root, options.scope, options.namespace);
	let store: LiteratureStore | undefined;
	if (options.mode === "persistent") {
		store = corpusStore;
		await store.initialize();
		if (!options.refreshCache) {
			const cached = await store.getDerived(cacheKey);
			if (cached && isSearchRun(cached.result)) {
				return { run: cached.result, cached: true, corpusPath: store.root };
			}
		}
	}
	const corpusHits = new Map<string, PaperRecord>();
	if (options.reuseCorpus !== false) {
		for (const query of queries) {
			for (const hit of await corpusStore.searchPapers({
				query,
				yearFrom: options.filters.yearFrom,
				yearTo: options.filters.yearTo,
				authors: options.filters.authors,
				venues: options.filters.venues,
				types: options.filters.types,
				openAccess: options.filters.openAccess,
				limit: options.maxResultsPerProvider,
				readOnly: options.mode === "once",
			})) {
				corpusHits.set(hit.record.id, hit.record);
			}
		}
	}

	const startedAt = new Date().toISOString();
	const providerOutcomes = options.corpusOnly
		? []
		: await Promise.all(
				options.providers.map(async (provider) => {
					const outcomes: Array<{
						provider: LiteratureProvider;
						query: string;
						records: PaperRecord[];
						failure?: ProviderFailure;
					}> = [];
					for (const query of queries) {
						const saved = checkpoint?.get(provider, query);
						const records: PaperRecord[] = [...(saved?.records ?? [])];
						if (saved?.done) {
							outcomes.push({ provider, query, records, failure: saved.failure });
							continue;
						}
						let cursor: string | undefined = saved?.cursor;
						let pagesCompleted = saved?.pagesCompleted ?? 0;
						try {
							const pageSize = Math.min(
								100,
								Math.max(1, Math.ceil(options.maxResultsPerProvider / options.pagesPerProvider)),
							);
							for (let page = saved?.pagesCompleted ?? 0; page < options.pagesPerProvider; page++) {
								const remaining = options.maxResultsPerProvider - records.length;
								if (remaining <= 0) break;
								const requested = Math.min(
									100,
									Math.min(pageSize, remaining) * (hasClientSideFilters(provider, options.filters) ? 3 : 1),
								);
								const response = await providerPageSearch(provider, {
									query,
									limit: requested,
									cursor,
									filters: options.filters,
									signal: options.signal,
								});
								records.push(...response.records.slice(0, remaining));
								cursor = response.nextCursor;
								pagesCompleted = page + 1;
								await checkpoint?.update({
									provider,
									query,
									records,
									cursor,
									pagesCompleted,
									done: !cursor || records.length >= options.maxResultsPerProvider,
								});
								if (!cursor) break;
							}
							await checkpoint?.update({
								provider,
								query,
								records,
								cursor,
								pagesCompleted: options.pagesPerProvider,
								done: true,
							});
							outcomes.push({ provider, query, records });
						} catch (error) {
							if (options.signal?.aborted) throw error;
							const message = readableErrorMessage(error);
							const statusMatch = /\b([1-5]\d\d)\b/.exec(message);
							const statusCode =
								error instanceof LiteratureProviderHttpError
									? error.statusCode
									: statusMatch
										? Number(statusMatch[1])
										: undefined;
							const failure: ProviderFailure = {
								provider,
								query,
								message,
								retryable: failureIsRetryable(message),
								statusCode,
								rateLimited: statusCode === 429,
								retryAfter: error instanceof LiteratureProviderHttpError ? error.retryAfter : undefined,
							};
							await checkpoint?.update({
								provider,
								query,
								records,
								cursor,
								pagesCompleted,
								done: !failure.retryable,
								failure,
							});
							outcomes.push({
								provider,
								query,
								records,
								failure,
							});
						}
					}
					return outcomes;
				}),
			);
	const allRecords: PaperRecord[] = [...corpusHits.values()];
	const failures: ProviderFailure[] = [];
	const sourceCounts: Partial<Record<LiteratureProvider, number>> = {};
	for (const outcome of providerOutcomes.flat()) {
		allRecords.push(...outcome.records);
		sourceCounts[outcome.provider] = (sourceCounts[outcome.provider] ?? 0) + outcome.records.length;
		if (outcome.failure) {
			failures.push(outcome.failure);
		}
	}
	const results = deduplicatePaperRecords(allRecords);
	const possibleDuplicates = findPossibleDuplicates(results);
	const checkedAt = new Date().toISOString();
	const providerHealth = Object.fromEntries(
		options.providers.map((provider) => {
			const providerFailures = failures.filter((failure) => failure.provider === provider);
			const recordCount = sourceCounts[provider] ?? 0;
			const status = providerFailures.some((failure) => failure.rateLimited)
				? "rate-limited"
				: providerFailures.length && recordCount
					? "partial"
					: providerFailures.length
						? "failed"
						: "healthy";
			return [
				provider,
				{
					status,
					recordCount,
					failureCount: providerFailures.length,
					checkedAt,
					message: providerFailures[0]?.message,
					retryAfter: providerFailures.find((failure) => failure.retryAfter)?.retryAfter,
				},
			];
		}),
	) as SearchRun["providerHealth"];
	const run: SearchRun = {
		id: "search-" + randomUUID(),
		startedAt,
		completedAt: new Date().toISOString(),
		queries,
		filters: options.filters,
		providers: options.providers,
		pagesPerProvider: options.pagesPerProvider,
		maxResultsPerProvider: options.maxResultsPerProvider,
		results,
		failures,
		sourceCounts,
		deduplicatedCount: allRecords.length - results.length,
		corpusHitCount: corpusHits.size,
		possibleDuplicates,
		providerHealth,
		resumedFromCheckpoint: checkpoint?.resumed || undefined,
		scope: options.scope,
		mode: options.mode,
		namespace: options.namespace,
	};

	let persistenceCounts: CollectionResult["persistenceCounts"];
	if (store) {
		persistenceCounts = await store.persistSearchRun(run);
		await store.putDerived(
			{
				key: cacheKey,
				paperId: "collection",
				operation: "literature-search",
				inputHashes: [queryFingerprint],
				pipelineVersion: "3",
				normalizedConfig: {
					queries,
					providers: options.providers,
					filters: options.filters,
					pagesPerProvider: options.pagesPerProvider,
					maxResultsPerProvider: options.maxResultsPerProvider,
				},
				createdAt: new Date().toISOString(),
				result: run,
			},
			{ replace: options.refreshCache },
		);
	}
	if (!failures.some((failure) => failure.retryable)) await checkpoint?.complete();
	return {
		run,
		cached: false,
		corpusPath: store?.root ?? (options.reuseCorpus === false ? undefined : corpusStore.root),
		persistenceCounts,
	};
}

async function collectCitationPages(
	loadPage: (limit: number, cursor?: string) => Promise<{ records: PaperRecord[]; nextCursor?: string }>,
	maxRecords: number,
	maxPages: number,
): Promise<PaperRecord[]> {
	const records: PaperRecord[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < maxPages && records.length < maxRecords; page++) {
		const result = await loadPage(Math.min(100, maxRecords - records.length), cursor);
		records.push(...result.records.slice(0, maxRecords - records.length));
		if (!result.nextCursor || result.nextCursor === cursor) break;
		cursor = result.nextCursor;
	}
	return records;
}

function formatPaper(record: PaperRecord, index: number): string {
	const sourceNames = [...new Set(record.provenance.map((item) => item.provider))].join(", ");
	return [
		String(index + 1) + ". " + record.title,
		"   id: " + record.id,
		"   authors: " + (record.authors.slice(0, 10).join(", ") || "unavailable"),
		"   year/venue: " + (record.year ?? "unknown") + " / " + (record.venue ?? "unknown"),
		"   DOI/arXiv: " + (record.identifiers.doi ?? "none") + " / " + (record.identifiers.arxivId ?? "none"),
		"   URL: " + (record.links[0]?.url ?? "unavailable"),
		"   sources: " + sourceNames,
	].join("\n");
}

function formatCollection(result: CollectionResult, displayLimit = 60): string {
	const run = result.run;
	const lines = [
		"Search run: " + run.id,
		"Queries: " + run.queries.join(" | "),
		"Providers: " + run.providers.join(", "),
		"Results: " + run.results.length + " unique; merged duplicates: " + run.deduplicatedCount,
		"Corpus hits reused: " + (run.corpusHitCount ?? 0),
		"Possible duplicates requiring review: " + (run.possibleDuplicates?.length ?? 0),
		"Source counts: " +
			run.providers.map((provider) => provider + "=" + (run.sourceCounts[provider] ?? 0)).join(", "),
		"Mode: " + run.scope + "/" + run.mode + "/" + run.namespace,
		"Cache: " + (result.cached ? "hit (no repeated API search)" : "miss"),
		result.corpusPath ? "Corpus: " + result.corpusPath : "Corpus: not written (once mode)",
		"",
		"Discovery results are leads, not evidence for substantive claims. Open the primary paper or official artifact.",
		"",
		...run.results.slice(0, displayLimit).map(formatPaper),
	];
	if (run.results.length > displayLimit) lines.push("[Only the first " + displayLimit + " records are displayed.]");
	if (run.possibleDuplicates?.length) {
		lines.push("", "Possible duplicates (not merged):");
		for (const candidate of run.possibleDuplicates.slice(0, 30)) {
			lines.push(
				"- " +
					candidate.leftId +
					" <> " +
					candidate.rightId +
					" title_similarity=" +
					candidate.titleSimilarity.toFixed(3),
			);
		}
	}
	if (run.failures.length) {
		lines.push("", "Partial provider failures:");
		for (const failure of run.failures) {
			lines.push(
				"- " +
					failure.provider +
					" / " +
					failure.query +
					": " +
					failure.message +
					" (retryable=" +
					failure.retryable +
					")",
			);
		}
	}
	return lines.join("\n");
}

function collectionParameters() {
	return Type.Object({
		query: Type.String({ description: "Primary focused literature query" }),
		query_expansions: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: 11,
				description: "Optional synonym, acronym, author/title, or adjacent-topic query variants",
			}),
		),
		auto_expand: Type.Optional(
			Type.Boolean({ description: "Add deterministic acronym and hyphenation variants; default: true" }),
		),
		providers: Type.Optional(
			Type.Array(providerSchema, {
				minItems: 1,
				maxItems: 9,
				description:
					"Search providers plus DOI enrichment sources. CORE requires CORE_API_KEY; Unpaywall requires UNPAYWALL_EMAIL.",
			}),
		),
		year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
		year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
		venues: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		authors: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		open_access: Type.Optional(Type.Boolean()),
		publication_types: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
		pages_per_provider: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Default: 1" })),
		max_results_per_provider: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 500, description: "Across pages for each provider/query; default: 20" }),
		),
		scope: Type.Optional(scopeSchema),
		mode: Type.Optional(modeSchema),
		namespace: Type.Optional(Type.String({ description: "Corpus namespace; default: default" })),
		corpus_root: Type.Optional(
			Type.String({ description: "Optional shared corpus base directory; default: .paper-agent/corpus" }),
		),
		refresh_cache: Type.Optional(
			Type.Boolean({
				description: "Ignore a matching persistent search cache and refresh providers; default: false",
			}),
		),
		reuse_corpus: Type.Optional(
			Type.Boolean({
				description: "Search the selected personal/team corpus before external providers; default: true",
			}),
		),
		corpus_only: Type.Optional(
			Type.Boolean({ description: "Search only the existing corpus and make no provider requests; default: false" }),
		),
	});
}

function optionsFromParams(
	params: {
		query: string;
		query_expansions?: string[];
		auto_expand?: boolean;
		providers?: LiteratureProvider[];
		year_from?: number;
		year_to?: number;
		venues?: string[];
		authors?: string[];
		open_access?: boolean;
		publication_types?: string[];
		pages_per_provider?: number;
		max_results_per_provider?: number;
		scope?: CorpusScope;
		mode?: PersistenceMode;
		namespace?: string;
		corpus_root?: string;
		refresh_cache?: boolean;
		reuse_corpus?: boolean;
		corpus_only?: boolean;
	},
	cwd: string,
	signal?: AbortSignal,
): CollectLiteratureOptions {
	if (params.year_from && params.year_to && params.year_from > params.year_to) {
		throw new Error("year_from cannot be later than year_to");
	}
	return {
		queries:
			params.auto_expand === false
				? uniqueQueries([params.query, ...(params.query_expansions ?? [])])
				: expandLiteratureQueries(params.query, params.query_expansions),
		providers: params.providers ?? ["arxiv", "openalex", "crossref"],
		filters: {
			yearFrom: params.year_from,
			yearTo: params.year_to,
			venues: params.venues,
			authors: params.authors,
			openAccess: params.open_access,
			types: params.publication_types,
		},
		pagesPerProvider: params.pages_per_provider ?? 1,
		maxResultsPerProvider: params.max_results_per_provider ?? 20,
		scope: params.scope ?? "personal",
		mode: params.mode ?? "once",
		namespace: params.namespace ?? "default",
		cwd,
		corpusRoot: params.corpus_root,
		refreshCache: params.refresh_cache,
		reuseCorpus: params.reuse_corpus ?? true,
		corpusOnly: params.corpus_only ?? false,
		signal,
	};
}

export function registerCollectionTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "collect_literature",
		label: "Collect literature",
		description:
			"Search the selected corpus first, then run a bounded plugin-based collection across arXiv, OpenAlex, Crossref, Semantic Scholar, DBLP, PubMed, CORE, OpenCitations, and Unpaywall with filters, pagination, deduplication, partial-failure reporting, optional persistent caching, and provenance.",
		promptSnippet: "Collect and deduplicate literature into a personal or team corpus",
		promptGuidelines: [
			"Review the deterministic acronym/hyphenation expansions, add explicit author/title or adjacent-term variants when useful, and preserve every executed query in the run manifest.",
			"Use once mode for exploratory searches and persistent mode when the results should be reused.",
			"Search metadata is discovery evidence only; verify substantive claims in primary sources.",
		],
		parameters: collectionParameters(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = optionsFromParams(params, ctx.cwd, signal);
			if (options.mode === "persistent") {
				if (!ctx.hasUI) {
					throw new Error(
						"Persistent collection requires interactive confirmation. Use once mode or the Paper Agent UI.",
					);
				}
				const manager = new OperationConsentManager({
					auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
				});
				const plan = collectionPersistencePlan(options);
				options.authorization = await requestOperationAuthorization(
					manager,
					plan,
					(prepared) =>
						ctx.ui.confirm(
							"Save literature collection?",
							[
								prepared.summary,
								`Corpus: ${prepared.targets[0]?.value}`,
								`Queries: ${options.queries.join(" | ")}`,
								`Providers: ${options.providers.join(", ")}`,
								`Manifest: ${prepared.manifestFingerprint}`,
							].join("\n"),
						),
					"interactive-user",
				);
			}
			const result = await collectLiterature(options);
			void appendSearchRunJournal(result.run, ctx.cwd);
			return {
				content: [{ type: "text", text: formatCollection(result) }],
				details: {
					searchRunId: result.run.id,
					queries: result.run.queries,
					resultCount: result.run.results.length,
					sourceCounts: result.run.sourceCounts,
					failures: result.run.failures,
					cached: result.cached,
					corpusPath: result.corpusPath,
					scope: result.run.scope,
					mode: result.run.mode,
					corpusHitCount: result.run.corpusHitCount ?? 0,
					possibleDuplicates: result.run.possibleDuplicates ?? [],
				},
			};
		},
	});

	pi.registerTool({
		name: "search_literature_corpus",
		label: "Search literature corpus",
		description:
			"Search an existing personal or team corpus without external network requests or writes. Supports title/abstract/author/venue/note text, identifiers, tags, years, and screening status.",
		promptSnippet: "Reuse papers and notes already present in a personal or team corpus",
		promptGuidelines: [
			"Search the corpus before starting a repeated collection or analysis task.",
			"Corpus matches are reusable records, not proof that a technical claim is correct.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			authors: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			venues: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			publication_types: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			open_access: Type.Optional(Type.Boolean()),
			tags: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
			identifiers: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
			screening_statuses: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("unreviewed"),
						Type.Literal("include"),
						Type.Literal("exclude"),
						Type.Literal("maybe"),
					]),
					{ maxItems: 4 },
				),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.year_from && params.year_to && params.year_from > params.year_to) {
				throw new Error("year_from cannot be later than year_to");
			}
			const scope = params.scope ?? "personal";
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			const hits = await store.searchPapers({
				query: params.query,
				yearFrom: params.year_from,
				yearTo: params.year_to,
				authors: params.authors,
				venues: params.venues,
				types: params.publication_types,
				openAccess: params.open_access,
				tags: params.tags,
				identifiers: params.identifiers,
				screeningStatuses: params.screening_statuses,
				limit: params.limit,
				readOnly: true,
			});
			const text = [
				`Corpus: ${store.root}`,
				`Scope: ${scope}/${namespace}`,
				`Matches: ${hits.length}`,
				"",
				...hits.map((hit, index) =>
					[
						formatPaper(hit.record, index),
						`   corpus_score: ${hit.score}; matched_fields: ${hit.matchedFields.join(", ") || "filters"}`,
					].join("\n"),
				),
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { corpusPath: store.root, scope, namespace, hitCount: hits.length, hits },
			};
		},
	});

	pi.registerTool({
		name: "expand_citation_network",
		label: "Expand citation network",
		description:
			"Expand references and/or citing works from OpenAlex records already stored in a persistent corpus. Expansion is bounded, provenance-preserving, and deduplicated.",
		promptSnippet: "Expand a paper's bounded OpenAlex citation neighborhood",
		promptGuidelines: [
			"Use citation expansion after a focused seed search, not as a substitute for a documented query strategy.",
		],
		parameters: Type.Object({
			seed_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "Corpus paper ids" }),
			direction: Type.Optional(
				Type.Union([Type.Literal("references"), Type.Literal("citations"), Type.Literal("both")]),
			),
			depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
			max_neighbors_per_seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			pages_per_seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
			max_total_neighbors: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			if (scope === "team") {
				throw new Error(
					"Citation expansion cannot write directly to a team corpus; expand in personal scope, then promote",
				);
			}
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			const loadedSeeds = await Promise.all(
				params.seed_ids.map(async (id) => ({ id, record: await store.getPaper(id) })),
			);
			const missingSeedIds = loadedSeeds.filter((item) => !item.record).map((item) => item.id);
			const seeds = loadedSeeds
				.map((item) => item.record)
				.filter((record): record is PaperRecord => Boolean(record));
			if (seeds.length === 0) throw new Error("None of the seed_ids exist in the selected corpus");
			const direction = params.direction ?? "both";
			const limit = params.max_neighbors_per_seed ?? 30;
			const depth = params.depth ?? 1;
			const pagesPerSeed = params.pages_per_seed ?? 3;
			const maxTotalNeighbors = params.max_total_neighbors ?? Math.min(1000, limit * seeds.length * depth);
			let frontier = seeds;
			const discovered: PaperRecord[] = [];
			const failures: string[] = [];
			const visited = new Set(seeds.map((seed) => seed.id));
			for (let level = 1; level <= depth; level++) {
				const next: PaperRecord[] = [];
				for (const seed of frontier) {
					if (discovered.length >= maxTotalNeighbors) break;
					let seedRemaining = Math.min(limit, maxTotalNeighbors - discovered.length);
					const accept = (records: PaperRecord[]) => {
						for (const record of deduplicatePaperRecords(records)) {
							if (seedRemaining <= 0 || discovered.length >= maxTotalNeighbors) break;
							if (visited.has(record.id)) continue;
							visited.add(record.id);
							next.push(record);
							discovered.push(record);
							seedRemaining--;
						}
					};
					if ((direction === "references" || direction === "both") && seedRemaining > 0) {
						try {
							if (seed.referencedWorks?.length) {
								accept(
									await fetchOpenAlexWorks(seed.referencedWorks.slice(0, seedRemaining), {
										signal,
										queryLabel: "references:" + seed.id,
									}),
								);
							} else if (seed.identifiers.semanticScholarId) {
								accept(
									await collectCitationPages(
										(pageLimit, cursor) =>
											searchSemanticScholarCitations(
												seed.identifiers.semanticScholarId ?? "",
												"references",
												{ limit: pageLimit, cursor, signal, queryLabel: "references:" + seed.id },
											),
										seedRemaining,
										pagesPerSeed,
									),
								);
							}
						} catch (error) {
							failures.push(`${seed.id}/references: ${readableErrorMessage(error)}`);
						}
					}
					if ((direction === "citations" || direction === "both") && seedRemaining > 0) {
						try {
							const workId = seed.identifiers.openAlexId;
							if (workId) {
								accept(
									await collectCitationPages(
										(pageLimit, cursor) =>
											searchOpenAlexCitations(workId, {
												limit: pageLimit,
												cursor,
												signal,
												queryLabel: "citations:" + seed.id,
											}),
										seedRemaining,
										pagesPerSeed,
									),
								);
							} else if (seed.identifiers.semanticScholarId) {
								accept(
									await collectCitationPages(
										(pageLimit, cursor) =>
											searchSemanticScholarCitations(seed.identifiers.semanticScholarId ?? "", "citations", {
												limit: pageLimit,
												cursor,
												signal,
												queryLabel: "citations:" + seed.id,
											}),
										seedRemaining,
										pagesPerSeed,
									),
								);
							}
						} catch (error) {
							failures.push(`${seed.id}/citations: ${readableErrorMessage(error)}`);
						}
					}
				}
				frontier = next;
				if (frontier.length === 0 || discovered.length >= maxTotalNeighbors) break;
			}
			const unique = discovered;
			const outcomes = unique.length
				? await persistPaperRecords(
						store,
						unique,
						await requestInteractiveOperationAuthorization(ctx, corpusUpsertPlan(store, unique), {
							title: "Save citation-network expansion?",
							unavailableMessage:
								"Citation-network expansion requires interactive confirmation before new papers are saved.",
							details: () => [
								`Seeds: ${seeds.map((seed) => seed.id).join(", ")}`,
								`Direction/depth: ${direction}/${depth}`,
							],
						}),
					)
				: [];
			const failedWrite = outcomes.find((outcome) => outcome.error);
			if (failedWrite) throw new Error(`Could not persist ${failedWrite.record.id}: ${failedWrite.error}`);
			return {
				content: [
					{
						type: "text",
						text: [
							"Expanded " + seeds.length + " seeds to " + unique.length + " unique neighboring papers.",
							"Direction/depth/pages: " + direction + "/" + depth + "/" + pagesPerSeed,
							"Neighbor budget: per-seed=" + limit + "; total=" + maxTotalNeighbors,
							missingSeedIds.length
								? "Missing seed ids: " + missingSeedIds.join(", ")
								: "Missing seed ids: none",
							"Corpus: " + store.root,
							failures.length ? "Failures:\n- " + failures.join("\n- ") : "Failures: none",
						].join("\n"),
					},
				],
				details: {
					seedCount: seeds.length,
					missingSeedIds,
					resultCount: unique.length,
					pagesPerSeed,
					maxTotalNeighbors,
					failures,
					corpusPath: store.root,
				},
			};
		},
	});

	pi.registerTool({
		name: "download_literature_pdfs",
		label: "Download literature PDFs",
		description:
			"Batch-download public PDF links for selected persistent corpus records into the content-addressed corpus store. Redirects are revalidated, private addresses and credentials are rejected, size is bounded, and files are never executed.",
		promptSnippet: "Safely batch-download paper PDFs into the corpus",
		promptGuidelines: [
			"Download only records selected for the corpus; disclose missing PDF links and failed acquisitions.",
		],
		parameters: Type.Object({
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
			max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			max_megabytes_per_file: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Default: 3" })),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			if (!ctx.hasUI) {
				throw new Error(
					"PDF downloads require interactive confirmation. Use the Paper Agent UI or interactive Pi.",
				);
			}
			const request = {
				paperIds: params.paper_ids,
				maxFiles: params.max_files ?? 20,
				maxBytesPerFile: (params.max_megabytes_per_file ?? 50) * 1024 * 1024,
				concurrency: params.concurrency ?? 3,
				signal,
			};
			const manager = new OperationConsentManager({
				auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
			});
			const plan = await literaturePdfDownloadPlan(store, request);
			const authorization = await requestOperationAuthorization(
				manager,
				plan,
				(prepared) =>
					ctx.ui.confirm(
						"Download selected PDFs?",
						[
							prepared.summary,
							`Corpus: ${store.root}`,
							`PDF targets: ${Math.max(0, prepared.targets.length - 1)}`,
							`Maximum bytes per file: ${request.maxBytesPerFile}`,
							`Manifest: ${prepared.manifestFingerprint}`,
						].join("\n"),
					),
				"interactive-user",
			);
			const { downloaded, failures, missingPaperIds } = await downloadLiteraturePdfs(store, request, authorization);
			return {
				content: [
					{
						type: "text",
						text: [
							"Downloaded PDFs: " + downloaded.length,
							"Failures/skips: " + failures.length,
							"Corpus: " + store.root,
							...downloaded.map(
								(item) =>
									"- " +
									item.paperId +
									" sha256=" +
									item.sha256 +
									" bytes=" +
									item.bytes +
									" path=" +
									item.blobPath,
							),
							...failures.map((item) => "- " + item.paperId + " failed: " + item.reason),
						].join("\n"),
					},
				],
				details: { downloaded, failures, missingPaperIds, corpusPath: store.root },
			};
		},
	});

	pi.registerTool({
		name: "manage_literature_memory",
		label: "Manage literature memory",
		description:
			"Look up or record a versioned derived task result such as a skim card or comparison matrix. Exact task-key hits are reused; changed inputs, tool/model/prompt versions, or configuration remain visible as alternatives instead of overwriting history.",
		promptSnippet: "Reuse versioned literature analysis before generating it again",
		promptGuidelines: [
			"Always run lookup before repeating a costly analysis; reuse an exact hit unless the user explicitly requests recomputation.",
			"Store generated analysis separately from user notes and primary-source metadata.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("lookup"), Type.Literal("record")]),
			paper_id: Type.String(),
			operation: Type.String({ description: "For example skim-card, comparison-matrix, or evidence-map" }),
			input_hashes: Type.Array(Type.String({ pattern: "^[a-fA-F0-9]{64}$" }), { minItems: 1, maxItems: 100 }),
			pipeline_version: Type.String(),
			model_version: Type.Optional(Type.String()),
			prompt_version: Type.Optional(Type.String()),
			normalized_config: Type.Optional(Type.Unknown()),
			result: Type.Optional(Type.Unknown()),
			created_by: Type.Optional(Type.String()),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			if (params.action === "record" && scope === "team") {
				throw new Error("Derived analysis cannot be recorded directly in team scope; record it personally first");
			}
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			const normalizedConfig = params.normalized_config ?? {};
			const key = derivedCacheKey({
				inputHashes: params.input_hashes,
				operation: params.operation,
				pipelineVersion: params.pipeline_version,
				modelVersion: params.model_version,
				promptVersion: params.prompt_version,
				normalizedConfig,
			});
			const exact = await store.getDerived(key);
			const alternatives = (
				await store.listDerived({ paperId: params.paper_id, operation: params.operation })
			).filter((record) => record.key !== key);
			if (params.action === "lookup" || exact) {
				return {
					content: [
						{
							type: "text",
							text: [
								`Task key: ${key}`,
								`Exact cache hit: ${Boolean(exact)}`,
								`Historical alternatives: ${alternatives.length}`,
								exact
									? `Result:\n${JSON.stringify(exact.result, null, 2)}`
									: "No exact result; generation may proceed.",
							].join("\n"),
						},
					],
					details: { key, cacheHit: Boolean(exact), exact, alternatives, corpusPath: store.root },
				};
			}
			if (params.result === undefined) throw new Error("result is required when action=record");
			if (!params.created_by?.trim()) throw new Error("created_by is required when action=record");
			const record: DerivedRecord = {
				key,
				paperId: params.paper_id,
				operation: params.operation,
				inputHashes: [...params.input_hashes].sort(),
				pipelineVersion: params.pipeline_version,
				modelVersion: params.model_version,
				promptVersion: params.prompt_version,
				normalizedConfig,
				createdAt: new Date().toISOString(),
				createdBy: params.created_by.trim(),
				result: params.result,
			};
			await persistDerivedRecord(
				store,
				record,
				await requestInteractiveOperationAuthorization(ctx, derivedRecordWritePlan(store, record), {
					title: "Record derived research memory?",
					unavailableMessage:
						"Recording derived research memory requires interactive confirmation. Lookup remains read-only.",
					details: () => [`Task key: ${key}`, `Created by: ${record.createdBy}`],
				}),
			);
			return {
				content: [{ type: "text", text: `Recorded derived task ${key} in ${store.root}` }],
				details: { key, cacheHit: false, alternatives, record, corpusPath: store.root },
			};
		},
	});

	pi.registerTool({
		name: "manage_literature_corpus",
		label: "Manage literature corpus",
		description:
			"Audit, export, annotate, or review a persistent corpus, or explicitly propose selected personal records to a team corpus. Promotion is one-way, records the contributor, and enters a pending team-review state.",
		promptSnippet: "Audit, curate, review, export, or promote reusable literature records",
		promptGuidelines: [
			"Keep personal and team namespaces separate; use promote only after checking record relevance and provenance.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("audit"),
				Type.Literal("export"),
				Type.Literal("annotate"),
				Type.Literal("promote"),
				Type.Literal("review"),
			]),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			format: Type.Optional(
				Type.Union([Type.Literal("markdown"), Type.Literal("csv"), Type.Literal("bibtex"), Type.Literal("json")]),
			),
			filename: Type.Optional(Type.String()),
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			target_namespace: Type.Optional(Type.String()),
			target_corpus_root: Type.Optional(Type.String()),
			contributor: Type.Optional(Type.String({ description: "Required for annotate and promote" })),
			tags: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
			note: Type.Optional(Type.String()),
			screening_status: Type.Optional(
				Type.Union([
					Type.Literal("unreviewed"),
					Type.Literal("include"),
					Type.Literal("exclude"),
					Type.Literal("maybe"),
				]),
			),
			screening_reason: Type.Optional(Type.String()),
			review_decision: Type.Optional(Type.Union([Type.Literal("team-approved"), Type.Literal("team-rejected")])),
			reviewer: Type.Optional(Type.String()),
			review_reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			if (params.action === "audit") {
				const audit = await store.audit({ readOnly: true });
				return {
					content: [{ type: "text", text: JSON.stringify(audit, null, 2) }],
					details: { ...audit, corpusPath: store.root },
				};
			}
			if (params.action === "export") {
				const format = params.format ?? "markdown";
				const filename = corpusExportFilename(format, params.filename);
				const records = await store.listPapers();
				const plan = corpusExportPlan(store, format, filename, records);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Export literature corpus?",
					unavailableMessage: "Corpus export requires interactive confirmation before writing the export file.",
				});
				const path = await runAuthorizedMutation(authorization, plan, () =>
					store.export(format, filename, records),
				);
				return {
					content: [{ type: "text", text: "Exported " + format + " corpus to " + path }],
					details: { exportPath: path, corpusPath: store.root },
				};
			}
			if (params.action === "annotate") {
				if (scope === "team") {
					throw new Error(
						"Personal-style annotations cannot be written directly to team scope; use review for team decisions",
					);
				}
				if (!params.paper_ids?.length) throw new Error("paper_ids is required when action=annotate");
				if (!params.contributor?.trim()) throw new Error("contributor is required when action=annotate");
				if (!params.tags?.length && !params.note?.trim() && !params.screening_status) {
					throw new Error("annotate requires tags, note, or screening_status");
				}
				const requested = await Promise.all(
					params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })),
				);
				const missing = requested.filter((item) => !item.record).map((item) => item.id);
				if (missing.length)
					throw new Error(`Paper ids were not found in the personal corpus: ${missing.join(", ")}`);
				const records = requested
					.map((item) => item.record)
					.filter((record): record is PaperRecord => Boolean(record));
				const annotation = {
					author: params.contributor.trim(),
					tags: params.tags,
					note: params.note,
					screeningStatus: params.screening_status,
					screeningReason: params.screening_reason,
				};
				const plan = corpusAnnotationPlan(store, records, annotation);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Update personal literature annotations?",
					unavailableMessage: "Personal annotations require interactive confirmation before they are saved.",
				});
				const updated = await runAuthorizedMutation(authorization, plan, async () => {
					const values = [];
					for (const record of records) values.push(await store.annotatePaper(record.id, annotation));
					return values;
				});
				return {
					content: [{ type: "text", text: `Annotated ${updated.length} records in ${store.root}` }],
					details: { updated, corpusPath: store.root },
				};
			}
			if (params.action === "review") {
				if (scope !== "team") throw new Error("Review action requires scope=team");
				if (!params.paper_ids?.length) throw new Error("paper_ids is required when action=review");
				if (!params.reviewer?.trim()) throw new Error("reviewer is required when action=review");
				if (!params.review_decision) throw new Error("review_decision is required when action=review");
				const decision = params.review_decision;
				const requested = await Promise.all(
					params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })),
				);
				const missing = requested.filter((item) => !item.record).map((item) => item.id);
				if (missing.length) throw new Error(`Paper ids were not found in the team corpus: ${missing.join(", ")}`);
				const records = requested
					.map((item) => item.record)
					.filter((record): record is PaperRecord => Boolean(record));
				const reviewer = params.reviewer.trim();
				const plan = corpusTeamReviewPlan(store, records, decision, reviewer, params.review_reason);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Review local team proposals?",
					unavailableMessage: "Team review decisions require interactive confirmation before they are saved.",
				});
				const reviewed = await runAuthorizedMutation(authorization, plan, async () => {
					const values = [];
					for (const record of records) {
						values.push(await store.reviewTeamPaper(record.id, decision, reviewer, params.review_reason));
					}
					return values;
				});
				return {
					content: [{ type: "text", text: `Reviewed ${reviewed.length} team records in ${store.root}` }],
					details: { reviewed, corpusPath: store.root },
				};
			}
			if (scope !== "personal") throw new Error("Promotion source must be a personal corpus");
			if (!params.contributor?.trim()) throw new Error("contributor is required when action=promote");
			const targetNamespace = params.target_namespace ?? namespace;
			const target = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "team", targetNamespace, params.target_corpus_root ?? params.corpus_root),
				"team",
				targetNamespace,
			);
			const requested = params.paper_ids
				? await Promise.all(params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })))
				: undefined;
			const missing = requested?.filter((item) => !item.record).map((item) => item.id) ?? [];
			const records = requested
				? requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record))
				: await store.listPapers();
			const contributor = params.contributor.trim();
			let promoted = { promoted: 0, missing };
			if (records.length) {
				const plan = corpusPromotionPlan(store, target, records, contributor);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Propose records to the local team corpus?",
					unavailableMessage: "Team proposals require interactive confirmation before records are copied.",
				});
				promoted = {
					promoted: await runAuthorizedMutation(authorization, plan, () =>
						target.proposePapers(records, contributor),
					),
					missing,
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							"Promoted " +
							promoted.promoted +
							" records to " +
							target.root +
							(promoted.missing.length ? "\nMissing ids: " + promoted.missing.join(", ") : ""),
					},
				],
				details: { ...promoted, sourcePath: store.root, targetPath: target.root },
			};
		},
	});
}
