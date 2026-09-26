import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeLiteratureProvider } from "../src/literature/application/literature-provider-probe.ts";
import type { LiteratureProvider, PaperRecord, ProviderPage } from "../src/literature/domain/literature-types.ts";
import {
	LiteratureProviderHttpError,
	literatureProviderDefinitions,
	type ProviderSearchOptions,
} from "../src/literature/infrastructure/literature-providers.ts";
import { runWithConcurrency } from "../web/src/search-provider-probe.ts";

const paper: PaperRecord = {
	id: "test-paper",
	title: "Example paper",
	authors: ["Researcher"],
	identifiers: {},
	links: [],
	provenance: [],
	mergedFrom: [],
};

function page(records: PaperRecord[] = [], failures: ProviderPage["failures"] = []): ProviderPage {
	return { provider: "arxiv", query: "machine learning", records, failures, requestUrl: "https://example.test" };
}

const searcher = (fn: (provider: LiteratureProvider, options: ProviderSearchOptions) => Promise<ProviderPage>) =>
	fn as typeof import("../src/literature/infrastructure/literature-providers.ts").searchProviderPage;

describe("literature provider probe", () => {
	beforeEach(() => {
		vi.stubEnv("CORE_API_KEY", "");
		vi.stubEnv("S2_API_KEY", "");
		vi.stubEnv("EXA_API_KEY", "");
	});
	afterEach(() => vi.unstubAllEnvs());
	it("uses the keyword catalog, fixed small queries, ACL constraints, and explicit saved credentials", async () => {
		const calls: Array<{ provider: LiteratureProvider; options: ProviderSearchOptions }> = [];
		const mock = searcher(async (provider, options) => {
			calls.push({ provider, options });
			return page([paper]);
		});
		for (const definition of literatureProviderDefinitions.filter((entry) =>
			entry.capabilities.includes("keyword-search"),
		)) {
			const result = await probeLiteratureProvider(
				definition.id,
				{ coreApiKey: "saved-core", exaApiKey: "saved-exa" },
				mock,
			);
			expect(result).toMatchObject({ status: "results", recordCount: 1, sampleTitle: "Example paper" });
			expect(JSON.stringify(result)).not.toContain("saved-core");
		}
		expect(calls).toHaveLength(
			literatureProviderDefinitions.filter((entry) => entry.capabilities.includes("keyword-search")).length,
		);
		expect(calls.every(({ options }) => options.limit === 3)).toBe(true);
		expect(calls.find(({ provider }) => provider === "acl_anthology")?.options).toMatchObject({
			query: "language",
			filters: { yearFrom: 2024, yearTo: 2024, venues: ["acl"] },
		});
		expect(calls.find(({ provider }) => provider === "usenix")?.options.query).toBe("security");
		expect(calls.find(({ provider }) => provider === "core")?.options.coreApiKey).toBe("saved-core");
		expect(calls.find(({ provider }) => provider === "exa")?.options.exaApiKey).toBe("saved-exa");
		await expect(probeLiteratureProvider("unpaywall", {}, mock)).rejects.toThrow(
			"Unsupported keyword search provider",
		);
	});

	it("classifies successful, empty, partial, missing-key and anonymous searches", async () => {
		expect(
			(
				await probeLiteratureProvider(
					"arxiv",
					{},
					searcher(async () => page()),
				)
			).status,
		).toBe("empty");
		expect(
			(
				await probeLiteratureProvider(
					"arxiv",
					{},
					searcher(async () =>
						page([paper], [{ provider: "arxiv", query: "x", message: "partial", retryable: true }]),
					),
				)
			).status,
		).toBe("partial");
		const neverCalled = vi.fn(async () => page([paper]));
		expect((await probeLiteratureProvider("core", {}, searcher(neverCalled))).status).toBe("missing-key");
		expect(neverCalled).not.toHaveBeenCalled();
		const anonymous = await probeLiteratureProvider(
			"semanticscholar",
			{},
			searcher(async () => page([paper])),
		);
		expect(anonymous.credentialMode).toBe("anonymous");
	});

	it.each([
		[401, "auth"],
		[403, "auth"],
		[429, "rate-limited"],
		[408, "network"],
		[502, "invalid-response"],
	] as const)("classifies HTTP %i", async (code, status) => {
		const result = await probeLiteratureProvider(
			"arxiv",
			{},
			searcher(async () => {
				throw new LiteratureProviderHttpError("arxiv", new Response("secret upstream body", { status: code }));
			}),
		);
		expect(result).toMatchObject({ status, httpStatus: code, recordCount: 0 });
		expect(JSON.stringify(result)).not.toContain("secret upstream body");
	});

	it("classifies timeout, network failure, and malformed response without leaking raw errors", async () => {
		const timeout = await probeLiteratureProvider(
			"arxiv",
			{},
			searcher(async () => new Promise<ProviderPage>(() => {})),
			2,
		);
		expect(timeout.status).toBe("network");
		const network = await probeLiteratureProvider(
			"arxiv",
			{},
			searcher(async () => {
				throw new Error("fetch failed: secret token");
			}),
		);
		expect(network.status).toBe("network");
		expect(JSON.stringify(network)).not.toContain("secret token");
		const invalid = await probeLiteratureProvider(
			"arxiv",
			{},
			searcher(async () => ({ ...page(), records: null as unknown as PaperRecord[] })),
		);
		expect(invalid.status).toBe("invalid-response");
	});

	it("caps the test-all pool at two in-flight requests and reports completion incrementally", async () => {
		let active = 0;
		let peak = 0;
		const completed: number[] = [];
		await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 2));
			completed.push(value);
			active--;
		});
		expect(peak).toBe(2);
		expect(completed).toHaveLength(5);
	});
});
