import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiteratureSearchJobInput, PaperAgentApplication } from "../application/paper-agent-application.ts";
import {
	ApiError,
	boundedStringArray,
	integerValue,
	json,
	namespaceValue,
	readJson,
	searchFilters,
} from "./web-http.ts";

export async function handleSearchRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	if (request.method === "POST" && url.pathname === "/api/search/providers/probe") {
		const body = await readJson(request);
		const supported = application
			.providerCatalog()
			.filter((provider) => provider.capabilities.includes("keyword-search"));
		if (typeof body.providerId !== "string" || !supported.some((provider) => provider.id === body.providerId)) {
			throw new ApiError(400, "Unsupported keyword search provider");
		}
		json(
			response,
			200,
			await application.probeSearchProvider(
				body.providerId as Parameters<typeof application.probeSearchProvider>[0],
			),
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/search/runs") {
		const runs = await application.listSearchRuns(namespaceValue(url.searchParams.get("namespace")));
		json(response, 200, {
			runs: runs.map((run) => ({
				id: run.id,
				queries: run.queries,
				providers: run.providers,
				startedAt: run.startedAt,
				completedAt: run.completedAt,
				resultCount: run.results.length,
				deduplicatedCount: run.deduplicatedCount,
				sourceCounts: run.sourceCounts,
				failures: run.failures,
				scope: run.scope,
				mode: run.mode,
				namespace: run.namespace,
			})),
		});
		return;
	}
	const searchRunPaperRoute = /^\/api\/search\/runs\/([^/]+)\/papers\/([^/]+)$/.exec(url.pathname);
	if (request.method === "GET" && searchRunPaperRoute) {
		const run = await application.getSearchRun(
			decodeURIComponent(searchRunPaperRoute[1]),
			namespaceValue(url.searchParams.get("namespace")),
		);
		if (!run) throw new ApiError(404, "search run not found");
		const paperId = decodeURIComponent(searchRunPaperRoute[2]);
		const paper = run.results.find((candidate) => candidate.id === paperId || candidate.mergedFrom.includes(paperId));
		if (!paper) throw new ApiError(404, "paper not found in search run");
		json(response, 200, { paperId: paper.id, abstract: paper.abstract ?? null });
		return;
	}
	const searchRunRoute = /^\/api\/search\/runs\/([^/]+)$/.exec(url.pathname);
	if (request.method === "GET" && searchRunRoute) {
		const id = decodeURIComponent(searchRunRoute[1]);
		const found = await application.getSearchRun(id, namespaceValue(url.searchParams.get("namespace")));
		if (!found) throw new ApiError(404, "search run not found");
		json(response, 200, { run: found });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/search") {
		const body = await readJson(request);
		if (typeof body.query !== "string" || !body.query.trim() || body.query.trim().length > 2_000)
			throw new ApiError(400, "query must contain 1-2000 characters");
		const providers = boundedStringArray(body.providers, "providers", 20, 64);
		if (providers?.length === 0) throw new ApiError(400, "Select at least one literature provider");
		const catalog = application.providerCatalog();
		const supportedProviders = new Set<string>(
			catalog.filter((provider) => provider.capabilities.includes("keyword-search")).map((provider) => provider.id),
		);
		const unsupportedProviders = (providers ?? []).filter((provider) => !supportedProviders.has(provider));
		if (unsupportedProviders.length) {
			throw new ApiError(400, `Unsupported literature provider(s): ${unsupportedProviders.join(", ")}`);
		}
		if (body.reuseCorpus !== undefined && typeof body.reuseCorpus !== "boolean") {
			throw new ApiError(400, "reuseCorpus must be a boolean");
		}
		const filters = searchFilters(body.filters);
		for (const providerId of providers ?? []) {
			const constraints = catalog.find((provider) => provider.id === providerId)?.searchConstraints;
			if (constraints?.exactYear && (filters.yearFrom === undefined || filters.yearFrom !== filters.yearTo)) {
				throw new ApiError(400, `${providerId} requires one exact year`);
			}
			if (constraints?.singleVenue && filters.venues?.length !== 1) {
				throw new ApiError(400, `${providerId} requires exactly one venue`);
			}
			if (
				constraints?.supportedVenues?.length &&
				filters.venues?.length === 1 &&
				!constraints.supportedVenues.includes(filters.venues[0].trim().toLowerCase())
			) {
				throw new ApiError(400, `${providerId} does not support venue: ${filters.venues[0]}`);
			}
		}
		const input: LiteratureSearchJobInput = {
			query: body.query.trim(),
			queryExpansions: boundedStringArray(body.queryExpansions, "queryExpansions", 20, 500),
			providers: providers as LiteratureSearchJobInput["providers"],
			filters,
			pagesPerProvider: integerValue(body.pagesPerProvider, "pagesPerProvider", 1, 20),
			maxResultsPerProvider: integerValue(body.maxResultsPerProvider, "maxResultsPerProvider", 1, 500),
			namespace: namespaceValue(body.namespace),
			reuseCorpus: typeof body.reuseCorpus === "boolean" ? body.reuseCorpus : undefined,
		};
		json(response, 202, await application.enqueueLiteratureSearch(input));
		return;
	}
	throw new ApiError(404, "Search API route not found");
}
