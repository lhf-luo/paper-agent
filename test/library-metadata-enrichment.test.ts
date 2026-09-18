import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { savePaperAgentConfig } from "../src/config/application/config-service.ts";
import { defaultPaperAgentConfig } from "../src/config/domain/config-validation.ts";
import type { LiteratureProvider, PaperRecord, ProviderPage } from "../src/literature/domain/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(overrides: Partial<PaperRecord> = {}): PaperRecord {
	return {
		id: "paper-metadata",
		title: "Original Metadata Title",
		authors: ["Original Author"],
		identifiers: {},
		links: [],
		provenance: [{ provider: "exa", query: "fixture", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
		curation: { tags: ["keep"], userNotes: [] },
		...overrides,
	};
}

async function fixture(options: {
	providers?: LiteratureProvider[];
	doiProviders?: LiteratureProvider[];
	searcher?: (provider: LiteratureProvider, options: any) => Promise<ProviderPage>;
	doiLookup?: (provider: LiteratureProvider, doi: string, options: any) => Promise<PaperRecord | undefined>;
}) {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-metadata-enrichment-"));
	temporaryPaths.push(root);
	const config = defaultPaperAgentConfig();
	config.search.providers = options.providers ?? [];
	config.search.doiEnrichmentProviders = options.doiProviders ?? [];
	await savePaperAgentConfig(root, config);
	const staticRoot = join(root, "dist", "web");
	await mkdir(staticRoot, { recursive: true });
	await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
	const application = new PaperAgentApplication({
		projectRoot: root,
		dataRoot: join(root, ".paper-agent"),
		metadataProviderSearcher: options.searcher,
		doiProviderLookup: options.doiLookup,
	});
	const server = await startLocalWebServer(application, { staticRoot });
	return { application, server };
}

async function post(serverUrl: string, path: string, body: unknown) {
	return fetch(`${serverUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function confirm(serverUrl: string, operation: { operationId: string; manifestFingerprint: string }) {
	const response = await post(serverUrl, "/api/operations/confirm", operation);
	expect(response.status, await response.clone().text()).toBe(200);
	return response.json();
}

describe("personal library metadata enrichment", () => {
	it("refreshes existing DOI metadata by configured provider priority", async () => {
		const doiLookup = vi.fn(async (provider: LiteratureProvider, doi: string) => {
			if (provider === "crossref") {
				return paper({
					id: "crossref-record",
					title: "Current Provider Title",
					authors: ["Current Author", "Second Author"],
					abstract: "Fresh abstract",
					year: 2025,
					venue: "FreshConf",
					publicationType: "conference-paper",
					identifiers: { doi },
					provenance: [
						{ provider, query: doi, retrievedAt: "2026-09-17T00:00:00.000Z", providerRecordId: "cr" },
					],
				});
			}
			return paper({
				id: "openalex-record",
				title: "Lower Priority Title",
				authors: ["Lower Priority Author"],
				year: 2026,
				venue: "OtherConf",
				citationCount: 19,
				referencedWorks: ["W1", "W2"],
				identifiers: { doi, openAlexId: "W100" },
				provenance: [
					{ provider, query: doi, retrievedAt: "2026-09-17T00:00:00.000Z", providerRecordId: "W100" },
				],
			});
		});
		const { application, server } = await fixture({
			doiProviders: ["crossref", "openalex"],
			doiLookup,
		});
		try {
			const original = paper({
				identifiers: { doi: "10.1000/refresh" },
				abstract: "Old abstract",
				year: 2020,
				venue: "OldConf",
				citationCount: 2,
				metadataConflicts: {
					abstract: [{ value: "Older archived abstract", sources: ["legacy-import"] }],
				},
			});
			await application.personalStore().upsertPaper(original);
			const preparedResponse = await post(server.url, "/api/library/metadata/prepare", {
				paperId: original.id,
				namespace: "default",
			});
			expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200);
			const preparation = (await preparedResponse.json()) as {
				status: string;
				prepared: { operationId: string; manifestFingerprint: string };
				replacedFields: string[];
			};
			expect(preparation.status).toBe("ready");
			expect(preparation.replacedFields).toEqual(
				expect.arrayContaining(["title", "authors", "abstract", "year", "venue", "citationCount"]),
			);
			expect((await application.personalStore().getPaper(original.id))?.year).toBe(2020);

			const grant = await confirm(server.url, preparation.prepared);
			const executeResponse = await post(server.url, "/api/library/metadata/execute", {
				paperId: original.id,
				namespace: "default",
				grant,
			});
			expect(executeResponse.status, await executeResponse.clone().text()).toBe(200);
			const refreshed = await application.personalStore().getPaper(original.id);
			expect(refreshed).toMatchObject({
				id: original.id,
				title: "Current Provider Title",
				authors: ["Current Author", "Second Author"],
				abstract: "Fresh abstract",
				year: 2025,
				venue: "FreshConf",
				citationCount: 19,
				referencedWorks: ["W1", "W2"],
				curation: { tags: ["keep"] },
			});
			expect(refreshed?.metadataConflicts?.year?.map((entry) => entry.value)).toEqual(
				expect.arrayContaining([2020, 2025, 2026]),
			);
			expect(refreshed?.metadataConflicts?.abstract?.map((entry) => entry.value)).toContain(
				"Older archived abstract",
			);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("discovers a DOI by exact normalized title and first author without replacing identity fields", async () => {
		const searcher = vi.fn(async (provider: LiteratureProvider, options: { query: string }) => ({
			provider,
			query: options.query,
			records: [
				paper({
					id: "keyword-result",
					title: "Metadata Discovery",
					authors: ["Yang, Chenyuan", "Another Author"],
					year: 2024,
					venue: "KeywordVenue",
					identifiers: { doi: "10.1000/discovered" },
					provenance: [
						{ provider, query: options.query, retrievedAt: "2026-09-17T00:00:00.000Z" },
					],
				}),
			],
			requestUrl: "https://provider.example/search",
		}));
		const doiLookup = vi.fn(async (provider: LiteratureProvider, doi: string) =>
			paper({
				id: "doi-result",
				title: "Provider Styled Metadata Discovery",
				authors: ["Provider Author List"],
				year: 2026,
				venue: "ExactDoiVenue",
				identifiers: { doi },
				provenance: [{ provider, query: doi, retrievedAt: "2026-09-17T00:00:00.000Z" }],
			}),
		);
		const { application, server } = await fixture({
			providers: ["openalex"],
			doiProviders: ["crossref"],
			searcher,
			doiLookup,
		});
		try {
			const original = paper({
				title: "Metadata Discovery",
				authors: ["Chenyuan Yang"],
				year: 2020,
			});
			await application.personalStore().upsertPaper(original);
			const preparedResponse = await post(server.url, "/api/library/metadata/prepare", {
				paperId: original.id,
			});
			const preparation = (await preparedResponse.json()) as {
				status: string;
				prepared: { operationId: string; manifestFingerprint: string };
			};
			expect(preparation.status).toBe("ready");
			const grant = await confirm(server.url, preparation.prepared);
			await post(server.url, "/api/library/metadata/execute", { paperId: original.id, grant });
			const refreshed = await application.personalStore().getPaper(original.id);
			expect(refreshed).toMatchObject({
				title: original.title,
				authors: original.authors,
				year: 2026,
				venue: "ExactDoiVenue",
				identifiers: { doi: "10.1000/discovered" },
			});
			expect(searcher).toHaveBeenCalledWith("openalex", expect.objectContaining({ limit: 5 }));
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("rejects fuzzy titles and different first authors even when a provider id matches", async () => {
		const searcher = vi.fn(async (provider: LiteratureProvider, options: { query: string }) => ({
			provider,
			query: options.query,
			records: [
				paper({
					id: "same-provider-id",
					title: "Strict Metadata Match",
					authors: ["Different Author"],
					identifiers: { doi: "10.1000/wrong-author", openAlexId: "W123" },
				}),
				paper({
					id: "fuzzy-title",
					title: "Strict Metadata Matching",
					authors: ["First Author"],
					identifiers: { doi: "10.1000/fuzzy-title" },
				}),
			],
			requestUrl: "https://provider.example/search",
		}));
		const { application, server } = await fixture({ providers: ["openalex"], searcher });
		try {
			const original = paper({
				title: "Strict Metadata Match",
				authors: ["First Author"],
				identifiers: { openAlexId: "W123" },
			});
			await application.personalStore().upsertPaper(original);
			const response = await post(server.url, "/api/library/metadata/prepare", { paperId: original.id });
			expect(response.status, await response.clone().text()).toBe(200);
			expect(await response.json()).toMatchObject({ status: "no-match", prepared: null });
			expect((await application.personalStore().getPaper(original.id))?.identifiers.doi).toBeUndefined();
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("reports provider failures without modifying the paper", async () => {
		const searcher = vi.fn(async () => {
			throw new Error("provider unavailable");
		});
		const { application, server } = await fixture({ providers: ["openalex"], searcher });
		try {
			const original = paper({ title: "Unavailable Metadata", authors: ["First Author"] });
			await application.personalStore().upsertPaper(original);
			const response = await post(server.url, "/api/library/metadata/prepare", { paperId: original.id });
			expect(response.status, await response.clone().text()).toBe(200);
			const result = (await response.json()) as {
				status: string;
				warnings: Array<{ provider: string; message: string }>;
				prepared: null;
			};
			expect(result).toMatchObject({ status: "no-match", prepared: null });
			expect(result.warnings).toEqual([
				expect.objectContaining({ provider: "openalex", message: "provider unavailable" }),
			]);
			expect(await application.personalStore().getPaper(original.id)).toEqual(original);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("returns unchanged when exact DOI metadata already matches", async () => {
		const doiLookup = vi.fn(async (_provider: LiteratureProvider, doi: string) =>
			paper({
				identifiers: { doi },
				links: [{ url: `https://doi.org/${doi}`, kind: "doi" }],
			}),
		);
		const { application, server } = await fixture({ doiProviders: ["crossref"], doiLookup });
		try {
			const original = paper({
				identifiers: { doi: "10.1000/unchanged" },
				links: [{ url: "https://doi.org/10.1000/unchanged", kind: "doi" }],
			});
			await application.personalStore().upsertPaper(original);
			const response = await post(server.url, "/api/library/metadata/prepare", { paperId: original.id });
			expect(response.status, await response.clone().text()).toBe(200);
			expect(await response.json()).toMatchObject({
				status: "unchanged",
				filledFields: [],
				replacedFields: [],
				prepared: null,
			});
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("returns no-match when every DOI provider fails and does not add a canonical link", async () => {
		const doiLookup = vi.fn(async () => {
			throw new Error("doi provider unavailable");
		});
		const { application, server } = await fixture({ doiProviders: ["crossref"], doiLookup });
		try {
			const original = paper({ identifiers: { doi: "10.1000/provider-failure" } });
			await application.personalStore().upsertPaper(original);
			const storedBefore = await application.personalStore().getPaper(original.id);
			const response = await post(server.url, "/api/library/metadata/prepare", { paperId: original.id });
			expect(response.status, await response.clone().text()).toBe(200);
			const result = (await response.json()) as {
				status: string;
				warnings: Array<{ message: string }>;
				prepared: null;
			};
			expect(result).toMatchObject({ status: "no-match", prepared: null });
			expect(result.warnings[0]?.message).toBe("doi provider unavailable");
			expect(await application.personalStore().getPaper(original.id)).toEqual(storedBefore);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("rejects an exact DOI candidate with a conflicting arXiv identity", async () => {
		const doiLookup = vi.fn(async (_provider: LiteratureProvider, doi: string) =>
			paper({
				year: 2026,
				identifiers: { doi, arxivId: "2401.00002" },
			}),
		);
		const { application, server } = await fixture({ doiProviders: ["crossref"], doiLookup });
		try {
			const original = paper({
				year: 2020,
				identifiers: { doi: "10.1000/arxiv-conflict", arxivId: "2401.00001" },
				links: [{ url: "https://doi.org/10.1000/arxiv-conflict", kind: "doi" }],
			});
			await application.personalStore().upsertPaper(original);
			const response = await post(server.url, "/api/library/metadata/prepare", { paperId: original.id });
			const result = (await response.json()) as {
				status: string;
				warnings: Array<{ message: string }>;
				prepared: null;
			};
			expect(result).toMatchObject({ status: "identity-conflict", prepared: null });
			expect(result.warnings[0]?.message).toContain("conflicting arXiv ID");
			expect((await application.personalStore().getPaper(original.id))?.year).toBe(2020);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("rejects execution when the paper changes after preparation", async () => {
		const doiLookup = vi.fn(async (_provider: LiteratureProvider, doi: string) =>
			paper({ year: 2026, identifiers: { doi } }),
		);
		const { application, server } = await fixture({ doiProviders: ["crossref"], doiLookup });
		try {
			const original = paper({
				year: 2020,
				identifiers: { doi: "10.1000/stale" },
				links: [{ url: "https://doi.org/10.1000/stale", kind: "doi" }],
			});
			await application.personalStore().upsertPaper(original);
			const preparedResponse = await post(server.url, "/api/library/metadata/prepare", { paperId: original.id });
			const preparation = (await preparedResponse.json()) as {
				status: string;
				prepared: { operationId: string; manifestFingerprint: string };
			};
			expect(preparation.status).toBe("ready");
			await application.personalStore().replacePaperMetadata({
				...original,
				curation: { tags: ["changed-after-prepare"], userNotes: [] },
			});
			const grant = await confirm(server.url, preparation.prepared);
			const executeResponse = await post(server.url, "/api/library/metadata/execute", {
				paperId: original.id,
				grant,
			});
			expect(executeResponse.status).toBe(500);
			expect(await executeResponse.text()).toContain("changed after preparation");
			expect((await application.personalStore().getPaper(original.id))?.year).toBe(2020);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("does not write an identifier that already belongs to another personal paper", async () => {
		const searcher = vi.fn(async (provider: LiteratureProvider, options: { query: string }) => ({
			provider,
			query: options.query,
			records: [
				paper({
					id: "duplicate-candidate",
					title: "Duplicate Discovery",
					authors: ["First Author"],
					identifiers: { doi: "10.1000/already-owned" },
					provenance: [{ provider, query: options.query, retrievedAt: "2026-09-17T00:00:00.000Z" }],
				}),
			],
			requestUrl: "https://provider.example/search",
		}));
		const { application, server } = await fixture({ providers: ["openalex"], searcher });
		try {
			const target = paper({ title: "Duplicate Discovery", authors: ["First Author"] });
			const existing = paper({
				id: "existing-doi-paper",
				title: "Published Duplicate Discovery",
				identifiers: { doi: "10.1000/already-owned" },
			});
			await application.personalStore().upsertPapers([target, existing]);
			const response = await post(server.url, "/api/library/metadata/prepare", { paperId: target.id });
			expect(response.status, await response.clone().text()).toBe(200);
			const result = (await response.json()) as {
				status: string;
				conflictingPaperId: string;
				prepared: null;
			};
			expect(result).toMatchObject({
				status: "identity-conflict",
				conflictingPaperId: existing.id,
				prepared: null,
			});
			expect((await application.personalStore().getPaper(target.id))?.identifiers.doi).toBeUndefined();
		} finally {
			await server.close();
			await application.close();
		}
	});
});
