import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	aclAnthologyFiltersForRecord,
	LiteratureProviderHttpError,
	literatureProviderDefinitions,
	searchAclAnthologyPage,
	searchCorePage,
	searchDblpPage,
	searchOpenCitationsPage,
	searchUnpaywallPage,
	searchUsenixPage,
} from "../src/literature/infrastructure/literature-providers.ts";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers");
const fixture = async (name: string) => JSON.parse(await readFile(join(fixtureRoot, name), "utf8"));
const textFixture = async (name: string) => readFile(join(fixtureRoot, name), "utf8");
const jsonResponse = (value: unknown) =>
	new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("replayable literature provider fixtures", () => {
	it("preserves HTTP status and Retry-After metadata for rate-limited providers", () => {
		const before = Date.now();
		const error = new LiteratureProviderHttpError(
			"DBLP",
			new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }),
		);
		const after = Date.now();

		expect(error.statusCode).toBe(429);
		expect(Date.parse(error.retryAfter ?? "")).toBeGreaterThanOrEqual(before + 120_000);
		expect(Date.parse(error.retryAfter ?? "")).toBeLessThanOrEqual(after + 120_000);
	});

	it("normalizes DBLP, CORE, OpenCitations, and Unpaywall records", async () => {
		const dblp = await searchDblpPage({
			query: "stateful fuzzing",
			limit: 10,
			fetcher: async () => jsonResponse(await fixture("dblp.json")),
		});
		expect(dblp.records[0]).toMatchObject({
			identifiers: { dblpKey: "conf/sec/Fuzz25", doi: "10.1000/fuzz.25" },
			year: 2025,
		});

		let coreAuthorization = "";
		const core = await searchCorePage({
			query: "state machine",
			limit: 10,
			coreApiKey: "fixture-key",
			fetcher: async (_input, init) => {
				coreAuthorization = new Headers(init?.headers).get("authorization") ?? "";
				return jsonResponse(await fixture("core.json"));
			},
		});
		expect(coreAuthorization).toBe("Bearer fixture-key");
		expect(core.records[0]).toMatchObject({
			identifiers: { coreId: "777" },
			links: expect.arrayContaining([expect.objectContaining({ kind: "pdf" })]),
		});

		const open = await searchOpenCitationsPage({
			query: "10.1000/open.fixture",
			limit: 1,
			fetcher: async () => jsonResponse(await fixture("opencitations.json")),
		});
		expect(open.records[0]).toMatchObject({ citationCount: 7, identifiers: { doi: "10.1000/open.fixture" } });

		const unpaywall = await searchUnpaywallPage({
			query: "https://doi.org/10.1000/unpaywall.fixture",
			limit: 1,
			unpaywallEmail: "researcher@example.org",
			fetcher: async () => jsonResponse(await fixture("unpaywall.json")),
		});
		expect(unpaywall.records[0].links).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "pdf", openAccess: true })]),
		);
		expect(unpaywall.requestUrl).toContain("email=[redacted]");
	});
	it("reads one exact ACL Anthology collection and rejects unconstrained searches before fetching", async () => {
		let requests = 0;
		const page = await searchAclAnthologyPage({
			query: "efficient model",
			limit: 10,
			filters: { yearFrom: 2024, yearTo: 2024, venues: ["ACL"] },
			fetcher: async () => {
				requests += 1;
				return new Response(await textFixture("acl-anthology.xml"), { status: 200 });
			},
		});
		expect(requests).toBe(1);
		expect(page).toMatchObject({ provider: "acl_anthology", total: 1 });
		expect(page.records[0]).toMatchObject({
			title: "QST: Efficient Language Model Tuning",
			authors: ["Ada Example", "Grace B. Researcher"],
			identifiers: { doi: "10.18653/v1/2024.acl-long.1" },
			provenance: [expect.objectContaining({ providerRecordId: "2024.acl-long.1" })],
			links: expect.arrayContaining([
				expect.objectContaining({ url: "https://aclanthology.org/2024.acl-long.1.pdf", kind: "pdf" }),
			]),
		});

		let invalidRequests = 0;
		await expect(
			searchAclAnthologyPage({
				query: "model",
				limit: 10,
				fetcher: async () => {
					invalidRequests += 1;
					return new Response();
				},
			}),
		).rejects.toThrow("one exact year");
		expect(invalidRequests).toBe(0);
	});

	it("derives ACL filters only from compatible imported-paper metadata", () => {
		const definition = literatureProviderDefinitions.find((provider) => provider.id === "acl_anthology");
		expect(definition?.searchConstraints).toMatchObject({ exactYear: true, singleVenue: true });
		expect(
			aclAnthologyFiltersForRecord({
				id: "paper-1",
				title: "Paper",
				authors: ["Ada"],
				year: 2024,
				venue: "Proceedings of the 2024 Conference on Empirical Methods in Natural Language Processing",
				identifiers: {},
				links: [],
				provenance: [],
				mergedFrom: [],
			}),
		).toEqual({ yearFrom: 2024, yearTo: 2024, venues: ["emnlp"] });
	});

	it("caches an ACL collection only for the default network fetcher", async () => {
		const xml = await textFixture("acl-anthology.xml");
		const fetchMock = vi.fn(async () => new Response(xml, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const options = {
			query: "efficient model",
			limit: 10,
			filters: { yearFrom: 2024, yearTo: 2024, venues: ["ACL"] },
		};
		await searchAclAnthologyPage(options);
		await searchAclAnthologyPage(options);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps successful USENIX records when another detail page fails", async () => {
		const searchHtml = await textFixture("usenix-search.html");
		const paperHtml = await textFixture("usenix-paper.html");
		const page = await searchUsenixPage({
			query: "ValScope",
			limit: 10,
			filters: { yearFrom: 2026, yearTo: 2026, venues: ["OSDI"] },
			fetcher: async (input) => {
				const url = String(input);
				if (url.includes("/search/site/")) return new Response(searchHtml, { status: 200 });
				if (url.includes("/unavailable")) return new Response("unavailable", { status: 503 });
				return new Response(paperHtml, { status: 200 });
			},
		});
		expect(page.nextCursor).toBe("1");
		expect(page.records).toHaveLength(1);
		expect(page.failures).toHaveLength(1);
		expect(page.records[0]).toMatchObject({
			authors: ["Li Lin", "Liehang Chen", "Rongxin Wu"],
			year: 2026,
			links: expect.arrayContaining([
				expect.objectContaining({ url: "https://www.usenix.org/system/files/osdi26-lin-li.pdf", kind: "pdf" }),
				expect.objectContaining({ url: "https://github.com/example/valscope", kind: "artifact" }),
			]),
		});
	});

	it("fails USENIX when every discovered detail page fails", async () => {
		const searchHtml = await textFixture("usenix-search.html");
		await expect(
			searchUsenixPage({
				query: "ValScope",
				limit: 10,
				fetcher: async (input) =>
					String(input).includes("/search/site/")
						? new Response(searchHtml, { status: 200 })
						: new Response("unavailable", { status: 503 }),
			}),
		).rejects.toThrow("could not read any paper detail page");
	});
});
