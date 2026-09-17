import { randomUUID } from "node:crypto";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import { deduplicatePaperRecords, findPossibleDuplicates, sha256Text } from "../domain/literature-identifiers.ts";
import { rerankByQueryRelevance } from "../domain/literature-relevance.ts";
import type {
	LiteratureProvider,
	PaperRecord,
	ProviderFailure,
	SearchFilters,
	SearchRun,
} from "../domain/literature-types.ts";
import { lookupCcfLevel } from "../infrastructure/ccf-ranking.ts";
import { LiteratureProviderHttpError, searchProviderPage } from "../infrastructure/literature-providers.ts";
import { LiteratureSearchCheckpoint } from "../infrastructure/literature-search-checkpoint.ts";
import type { CollectionResult, CollectLiteratureOptions } from "./literature-collection-contracts.ts";
import {
	buildCandidatePaperTable,
	uniqueQueries,
	withCorpusDiscoveryPath,
	withProviderDiscoveryPath,
} from "./literature-query-planning.ts";
import { derivedCacheKey, LiteratureStore, resolveCorpusRoot } from "./literature-store.ts";

export type { CollectionResult, CollectLiteratureOptions } from "./literature-collection-contracts.ts";

export function collectionPersistencePlan(options: CollectLiteratureOptions): OperationPlan {
	const root = resolveCorpusRoot(options.cwd, options.scope, options.namespace, options.corpusRoot);
	return {
		kind: options.scope === "team" ? "team-write" : "personal-corpus-write",
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

const PROVIDER_THROTTLE_MS: Partial<Record<LiteratureProvider, number>> = {
	arxiv: 3200,
	dblp: 1600,
	semanticscholar: 3000,
	usenix: 2000,
	crossref: 1300,
	openalex: 1200,
};

function throttleProviderRequest(provider: LiteratureProvider, signal?: AbortSignal): Promise<void> {
	const waitMs = PROVIDER_THROTTLE_MS[provider] ?? 1100;
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, waitMs);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
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

function normalizeSearchRun(run: SearchRun): SearchRun {
	return { ...run, candidateTable: run.candidateTable ?? buildCandidatePaperTable(run.results) };
}

function failureIsRetryable(message: string): boolean {
	return /\b(?:408|425|429|5\d\d)\b|timed?\s*out|temporar|network|fetch failed|socket hang up|ECONN|ENOTFOUND|ETIMEDOUT/i.test(
		message,
	);
}

function hasClientSideFilters(provider: LiteratureProvider, filters: SearchFilters): boolean {
	if (provider === "arxiv" || provider === "semanticscholar") {
		return Object.values(filters).some((value) => value !== undefined && (!Array.isArray(value) || value.length > 0));
	}
	if (provider === "openalex")
		return Boolean(filters.venues?.length || filters.authors?.length || filters.types?.length);
	if (provider === "dblp" || provider === "core") {
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
		pipelineVersion: "4",
		normalizedConfig: normalizedSearchConfig,
	});
	const root = resolveCorpusRoot(options.cwd, options.scope, options.namespace, options.corpusRoot);
	const corpusStore = new LiteratureStore(root, options.scope, options.namespace);
	let store: LiteratureStore | undefined;
	store = corpusStore;
	await store.initialize();
	if (options.mode === "persistent" && !options.refreshCache) {
		const cached = await store.getDerived(cacheKey);
		if (cached && isSearchRun(cached.result)) {
			return { run: normalizeSearchRun(cached.result), cached: true, corpusPath: store.root };
		}
	}
	const corpusHits = new Map<string, PaperRecord>();
	if (options.reuseCorpus !== false) {
		for (const query of queries) {
			const discoveredAt = new Date().toISOString();
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
				const record = withCorpusDiscoveryPath(hit.record, query, discoveredAt);
				const existing = corpusHits.get(record.id);
				corpusHits.set(record.id, existing ? deduplicatePaperRecords([existing, record])[0] : record);
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
						failures: ProviderFailure[];
						failed: boolean;
					}> = [];
					for (const query of queries) {
						const saved = checkpoint?.get(provider, query);
						const records: PaperRecord[] = [...(saved?.records ?? [])];
						if (saved?.done) {
							outcomes.push({
								provider,
								query,
								records,
								failures: [...(saved.failures ?? []), ...(saved.failure ? [saved.failure] : [])],
								failed: Boolean(saved.failure),
							});
							continue;
						}
						let cursor: string | undefined = saved?.cursor;
						let pagesCompleted = saved?.pagesCompleted ?? 0;
						const partialFailures = [...(saved?.failures ?? [])];
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
								await throttleProviderRequest(provider, options.signal);
								const requestCursor = cursor;
								const response = await providerPageSearch(provider, {
									query,
									limit: requested,
									cursor,
									filters: options.filters,
									signal: options.signal,
								});
								partialFailures.push(...(response.failures ?? []));
								const discoveredAt = new Date().toISOString();
								records.push(
									...response.records
										.slice(0, remaining)
										.map((record) => withProviderDiscoveryPath(record, provider, query, discoveredAt)),
								);
								cursor = response.nextCursor;
								const cursorStalled = Boolean(cursor && cursor === requestCursor);
								pagesCompleted = page + 1;
								await checkpoint?.update({
									provider,
									query,
									records,
									cursor,
									pagesCompleted,
									done: !cursor || cursorStalled || records.length >= options.maxResultsPerProvider,
									failures: partialFailures,
								});
								if (!cursor || cursorStalled) break;
							}
							await checkpoint?.update({
								provider,
								query,
								records,
								cursor,
								pagesCompleted: options.pagesPerProvider,
								done: true,
								failures: partialFailures,
							});
							outcomes.push({ provider, query, records, failures: partialFailures, failed: false });
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
								failures: partialFailures,
								failure,
							});
							outcomes.push({
								provider,
								query,
								records,
								failures: [...partialFailures, failure],
								failed: true,
							});
							// 熔断: 该 provider 当前 query 已失败, 不再尝试剩余 query, 避免逐个超时白等。
							break;
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
		failures.push(...outcome.failures);
	}
	// 多源结果原本按 provider 块状拼接, 这里按查询相关性统一重排, 精确标题命中排到最前。
	const results = rerankByQueryRelevance(deduplicatePaperRecords(allRecords), queries);
	for (const record of results) {
		if (!record.venueRank) record.venueRank = lookupCcfLevel(record.venue);
	}
	const possibleDuplicates = findPossibleDuplicates(results);
	const checkedAt = new Date().toISOString();
	const outcomeByPair = new Map(
		providerOutcomes.flat().map((outcome) => [`${outcome.provider}\n${outcome.query}`, outcome] as const),
	);
	const executions = options.providers.flatMap((provider) =>
		queries.map((query) => {
			const outcome = outcomeByPair.get(`${provider}\n${query}`);
			if (outcome) {
				return {
					query,
					provider,
					status: outcome.failed
						? ("failed" as const)
						: outcome.failures.length
							? ("partial" as const)
							: ("succeeded" as const),
					resultCount: outcome.records.length,
					...(outcome.failures[0]?.message ? { message: outcome.failures[0].message } : {}),
				};
			}
			return {
				query,
				provider,
				status: "skipped" as const,
				resultCount: 0,
				message: options.corpusOnly ? "corpus_only was requested" : "provider stopped after an earlier failure",
			};
		}),
	);
	const executedQueries = new Set(
		executions.filter((execution) => execution.status !== "skipped").map((execution) => execution.query),
	);
	const failedExecutionCount = executions.filter((execution) => execution.status === "failed").length;
	const skippedExecutionCount = executions.filter((execution) => execution.status === "skipped").length;
	const coverage: NonNullable<SearchRun["coverage"]> = {
		plannedQueryCount: queries.length,
		executedQueryCount: executedQueries.size,
		failedExecutionCount,
		skippedExecutionCount,
		status: failures.length || skippedExecutionCount ? "partial" : "complete",
	};
	const providerHealth = Object.fromEntries(
		options.providers.map((provider) => {
			const providerFailures = failures.filter((failure) => failure.provider === provider);
			const recordCount = sourceCounts[provider] ?? 0;
			const status = options.corpusOnly
				? "not-run"
				: providerFailures.length && recordCount
					? "partial"
					: providerFailures.some((failure) => failure.rateLimited)
						? "rate-limited"
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
		id: `search-${randomUUID()}`,
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
		executions,
		coverage,
		resumedFromCheckpoint: checkpoint?.resumed || undefined,
		searchPlan: options.searchPlan ? { ...options.searchPlan, queryVariants: queries } : undefined,
		runKind: "keyword",
		candidateTable: buildCandidatePaperTable(results),
		scope: options.scope,
		mode: options.mode,
		namespace: options.namespace,
	};

	let persistenceCounts: CollectionResult["persistenceCounts"];
	if (store) {
		if (options.mode === "persistent") {
			persistenceCounts = await store.persistSearchRun(run);
		} else {
			await store.saveSearchRun(run);
		}
		if (options.mode === "persistent") {
			await store.putDerived(
				{
					key: cacheKey,
					paperId: "collection",
					operation: "literature-search",
					inputHashes: [queryFingerprint],
					pipelineVersion: "4",
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
	}
	if (!failures.some((failure) => failure.retryable)) await checkpoint?.complete();
	return {
		run,
		cached: false,
		corpusPath: store?.root ?? (options.reuseCorpus === false ? undefined : corpusStore.root),
		persistenceCounts,
	};
}
