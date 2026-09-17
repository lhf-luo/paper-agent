import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enrichMissingAbstractsByDoi } from "../src/literature/application/literature-abstract-enrichment.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { LiteratureProviderHttpError } from "../src/literature/infrastructure/literature-providers.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(id: string, doi?: string, abstract?: string): PaperRecord {
	return {
		id,
		title: `Paper ${id}`,
		abstract,
		authors: ["Ada Author"],
		identifiers: doi ? { doi } : {},
		links: [],
		provenance: [],
		mergedFrom: [],
	};
}

describe("DOI abstract enrichment", () => {
	it("skips complete and DOI-less records and stops after the first abstract", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-abstracts-"));
		temporaryPaths.push(root);
		const calls: string[] = [];
		const result = await enrichMissingAbstractsByDoi(
			[paper("complete", "10.1234/complete", "present"), paper("missing-doi"), paper("target", "10.1234/target")],
			root,
			{
				lookup: async (provider, doi) => {
					calls.push(`${provider}:${doi}`);
					return provider === "crossref" ? paper("candidate", doi, "filled abstract") : undefined;
				},
			},
		);

		expect(calls).toEqual(["crossref:10.1234/target"]);
		expect(result.records[2].abstract).toBe("filled abstract");
		expect(result.summary).toMatchObject({
			status: "complete",
			alreadyPresent: 1,
			attempted: 1,
			filled: 1,
			skippedWithoutDoi: 1,
		});
		expect(result.summary.providers.opencitations).toBeUndefined();
		expect(result.summary.providers.unpaywall).toBeUndefined();
	});

	it("limits record concurrency to three", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-abstract-concurrency-"));
		temporaryPaths.push(root);
		let active = 0;
		let maximum = 0;
		await enrichMissingAbstractsByDoi(
			Array.from({ length: 8 }, (_, index) => paper(String(index), `10.2345/${index}`)),
			root,
			{
				lookup: async (_provider, doi) => {
					active++;
					maximum = Math.max(maximum, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					active--;
					return paper("candidate", doi, "abstract");
				},
			},
		);
		expect(maximum).toBe(3);
	});

	it("uses only providers that can return abstracts, in configured order", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-abstract-providers-"));
		temporaryPaths.push(root);
		const calls: string[] = [];
		const result = await enrichMissingAbstractsByDoi([paper("target", "10.4567/target")], root, {
			lookup: async (provider) => {
				calls.push(provider);
				return undefined;
			},
		});
		expect(calls).toEqual(["crossref", "openalex", "semanticscholar"]);
		expect(result.summary).toMatchObject({ status: "complete", attempted: 1, notFound: 1 });
	});

	it("circuit-breaks retryable provider failures, continues fallback, and does not break on 404", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-abstract-circuit-"));
		temporaryPaths.push(root);
		const crossrefCalls: string[] = [];
		const result = await enrichMissingAbstractsByDoi(
			Array.from({ length: 5 }, (_, index) => paper(String(index), `10.3456/${index}`)),
			root,
			{
				concurrency: 1,
				lookup: async (provider, doi) => {
					if (provider === "crossref") {
						crossrefCalls.push(doi);
						if (doi.endsWith("/0"))
							throw new LiteratureProviderHttpError(provider, new Response(null, { status: 429 }));
					}
					if (provider === "openalex") {
						if (doi.endsWith("/1"))
							throw new LiteratureProviderHttpError(provider, new Response(null, { status: 404 }));
						return paper("candidate", doi, "fallback abstract");
					}
					return paper("candidate", doi, "last fallback abstract");
				},
			},
		);

		expect(crossrefCalls).toEqual(["10.3456/0"]);
		expect(result.records.every((record) => Boolean(record.abstract))).toBe(true);
		expect(result.summary.status).toBe("partial");
		expect(result.summary.providers.crossref).toMatchObject({ status: "disabled-rate-limit", attempted: 1 });
		expect(result.summary.providers.openalex).toMatchObject({ status: "healthy", attempted: 5, notFound: 1 });
	});

	it("marks the run partial when every abstract provider is circuit-broken", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-abstract-all-disabled-"));
		temporaryPaths.push(root);
		const result = await enrichMissingAbstractsByDoi([paper("target", "10.5678/target")], root, {
			concurrency: 1,
			lookup: async (provider) => {
				throw new LiteratureProviderHttpError(provider, new Response(null, { status: 503 }));
			},
		});
		expect(result.records[0].abstract).toBeUndefined();
		expect(result.summary).toMatchObject({ status: "partial", attempted: 1, filled: 0, failed: 1 });
		expect(Object.values(result.summary.providers).every((state) => state?.status === "disabled-server")).toBe(true);
	});
});
