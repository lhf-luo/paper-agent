import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	LiteratureProviderHttpError,
	searchCorePage,
	searchDblpPage,
	searchOpenCitationsPage,
	searchPubmedPage,
	searchUnpaywallPage,
} from "../src/literature-providers.ts";
import type { Fetcher } from "../src/network-security.ts";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers");
const fixture = async (name: string) => JSON.parse(await readFile(join(fixtureRoot, name), "utf8"));
const jsonResponse = (value: unknown) =>
	new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

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

	it("replays PubMed's two-request search and summary flow", async () => {
		const requests: string[] = [];
		const fetcher: Fetcher = async (input) => {
			const url = String(input);
			requests.push(url);
			return jsonResponse(await fixture(url.includes("esearch") ? "pubmed-search.json" : "pubmed-summary.json"));
		};
		const result = await searchPubmedPage({ query: "biomedical evidence", limit: 10, fetcher });
		expect(requests).toHaveLength(2);
		expect(result.records[0]).toMatchObject({
			identifiers: { pmid: "42424242", doi: "10.1000/pubmed.fixture" },
			year: 2024,
		});
	});
});
