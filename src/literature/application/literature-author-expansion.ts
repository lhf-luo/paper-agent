import { randomUUID } from "node:crypto";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import type { Fetcher } from "../../shared/infrastructure/network-security.ts";
import { deduplicatePaperRecords, findPossibleDuplicates } from "../domain/literature-identifiers.ts";
import type { PaperRecord, SearchRun } from "../domain/literature-types.ts";
import { lookupCcfLevel } from "../infrastructure/ccf-ranking.ts";
import {
	type AuthorPaperProvider,
	type AuthorSourceOptions,
	type AuthorSourceResult,
	findAuthorSourcePapers,
	isSeedWork,
	sameAuthorName,
} from "../infrastructure/provider-author-papers.ts";
import { providerFailureFromError } from "../infrastructure/provider-common.ts";
import { buildCandidatePaperTable } from "./literature-query-planning.ts";

const AUTHOR_PROVIDERS: AuthorPaperProvider[] = ["openalex", "semanticscholar", "dblp"];

export interface FindAuthorPapersOptions {
	seed: PaperRecord;
	authorName: string;

	maxResultsPerProvider?: number;
	yearFrom?: number;
	yearTo?: number;
	signal?: AbortSignal;
	fetcher?: Fetcher;
	sourceSearch?: (provider: AuthorPaperProvider, options: AuthorSourceOptions) => Promise<AuthorSourceResult>;
}

export async function collectAuthorPapers(options: FindAuthorPapersOptions): Promise<SearchRun> {
	const authorName = options.authorName.trim();
	const matchingAuthors = options.seed.authors.filter((name) => sameAuthorName(name, authorName));
	if (matchingAuthors.length !== 1) {
		throw new Error(`author_name must uniquely match one seed-paper author; found ${matchingAuthors.length}`);
	}
	if (options.yearFrom && options.yearTo && options.yearFrom > options.yearTo) {
		throw new Error("year_from cannot be later than year_to");
	}
	const limit = options.maxResultsPerProvider ?? 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new Error("max_results_per_provider must be between 1 and 500");
	}
	const startedAt = new Date().toISOString();
	const sourceSearch = options.sourceSearch ?? findAuthorSourcePapers;
	const sourceOptions: AuthorSourceOptions = {
		seed: options.seed,
		authorName: matchingAuthors[0],
		limit: limit + 1,
		yearFrom: options.yearFrom,
		yearTo: options.yearTo,
		signal: options.signal,
		fetcher: options.fetcher,
	};
	const outcomes = await Promise.all(
		AUTHOR_PROVIDERS.map(async (provider) => {
			try {
				return { provider, result: await sourceSearch(provider, sourceOptions) };
			} catch (error) {
				return { provider, error };
			}
		}),
	);
	const failures = outcomes.flatMap((outcome) => {
		if ("error" in outcome)
			return [providerFailureFromError(outcome.provider, `author:${authorName}`, outcome.error)];
		if (outcome.result.status === "partial" && outcome.result.message) {
			return [providerFailureFromError(outcome.provider, `author:${authorName}`, new Error(outcome.result.message))];
		}
		return [];
	});
	const sources: NonNullable<SearchRun["authorExpansion"]>["sources"] = {};
	const sourceCounts: SearchRun["sourceCounts"] = {};
	const allRecords: PaperRecord[] = [];
	const checkedAt = new Date().toISOString();
	for (const outcome of outcomes) {
		if ("error" in outcome) {
			sources[outcome.provider] = {
				status: "failed",
				fetchedCount: 0,
				truncated: false,
				message: readableErrorMessage(outcome.error),
			};
			sourceCounts[outcome.provider] = 0;
			continue;
		}
		const result = outcome.result;
		const otherRecords = result.records.filter((record) => !isSeedWork(options.seed, record, matchingAuthors[0]));
		const truncated = result.truncated || otherRecords.length > limit;
		sourceCounts[outcome.provider] = Math.min(otherRecords.length, limit);
		sources[outcome.provider] = {
			status:
				result.status === "unresolved"
					? "unresolved"
					: result.status === "partial" || truncated
						? "partial"
						: "succeeded",
			authorId: result.authorId,
			profileUrl: result.profileUrl,
			fetchedCount: Math.min(otherRecords.length, limit),
			total: result.total,
			truncated,
			message: result.message,
		};
		for (const record of otherRecords.slice(0, limit)) {
			allRecords.push({
				...record,
				discoveryPaths: [
					...(record.discoveryPaths ?? []),
					{
						kind: "author-homepage",
						provider: outcome.provider,
						query: matchingAuthors[0],
						seedPaperId: options.seed.id,
						sourceUrl: result.profileUrl,
						discoveredAt: checkedAt,
					},
				],
			});
		}
	}
	const results = deduplicatePaperRecords(allRecords).sort(
		(left, right) => (right.year ?? 0) - (left.year ?? 0) || left.title.localeCompare(right.title),
	);
	for (const record of results) if (!record.venueRank) record.venueRank = lookupCcfLevel(record.venue);
	const query = `author:${matchingAuthors[0]}`;
	const executions: NonNullable<SearchRun["executions"]> = outcomes.map((outcome) => {
		if ("error" in outcome)
			return {
				provider: outcome.provider,
				query,
				status: "failed",
				resultCount: 0,
				message: readableErrorMessage(outcome.error),
			};
		const result = outcome.result;
		const source = sources[outcome.provider];
		return {
			provider: outcome.provider,
			query,
			status: result.status === "unresolved" ? "skipped" : source?.status === "partial" ? "partial" : "succeeded",
			resultCount: source?.fetchedCount ?? 0,
			message: result.message,
		};
	});
	return {
		id: `search-author-${randomUUID()}`,
		startedAt,
		completedAt: new Date().toISOString(),
		queries: [query],
		filters: { yearFrom: options.yearFrom, yearTo: options.yearTo },
		providers: AUTHOR_PROVIDERS,
		pagesPerProvider: Math.ceil((limit + 1) / 100),
		maxResultsPerProvider: limit,
		results,
		failures,
		sourceCounts,
		deduplicatedCount: allRecords.length - results.length,
		possibleDuplicates: findPossibleDuplicates(results),
		executions,
		coverage: {
			plannedQueryCount: 1,
			executedQueryCount: executions.some((item) => item.status === "succeeded" || item.status === "partial")
				? 1
				: 0,
			failedExecutionCount: executions.filter((item) => item.status === "failed").length,
			skippedExecutionCount: executions.filter((item) => item.status === "skipped").length,
			status: executions.every((item) => item.status === "succeeded") ? "complete" : "partial",
		},
		providerHealth: Object.fromEntries(
			outcomes.map((outcome) => [
				outcome.provider,
				{
					status:
						"error" in outcome
							? "failed"
							: sources[outcome.provider]?.status === "unresolved"
								? "not-run"
								: sources[outcome.provider]?.status === "partial"
									? "partial"
									: "healthy",
					recordCount: sourceCounts[outcome.provider] ?? 0,
					failureCount: failures.filter((failure) => failure.provider === outcome.provider).length,
					checkedAt,
					message: "error" in outcome ? readableErrorMessage(outcome.error) : outcome.result.message,
				},
			]),
		),
		runKind: "author-expansion",
		seedPaperIds: [options.seed.id],
		authorExpansion: { seedPaperId: options.seed.id, authorName: matchingAuthors[0], sources },
		candidateTable: buildCandidatePaperTable(results),
		scope: "personal",
		mode: "once",
	};
}
