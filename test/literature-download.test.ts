import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import {
	downloadLiteraturePdfs,
	type LiteraturePdfDownloadRequest,
	prepareLiteraturePdfDownload,
} from "../src/literature/application/literature-download.ts";
import { LiteratureStore } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { OperationConsentManager } from "../src/shared/application/operation-consent.ts";

const publicResolver = async () => [{ address: "93.184.216.34" }];

function paper(overrides: Partial<PaperRecord> = {}): PaperRecord {
	return {
		id: "paper-1",
		title: "Paper",
		authors: ["Researcher"],
		identifiers: {},
		links: [],
		provenance: [{ provider: "local-pdf", query: "test", retrievedAt: new Date().toISOString() }],
		mergedFrom: [],
		...overrides,
	};
}

function requestFor(root: string, record: PaperRecord, fetcher: LiteraturePdfDownloadRequest["fetcher"]) {
	return {
		paperIds: [record.id],
		maxFiles: 1,
		maxBytesPerFile: 1024,
		concurrency: 1,
		projectRoot: root,
		fetcher,
		resolver: publicResolver,
	} satisfies LiteraturePdfDownloadRequest;
}

async function authorization(store: LiteratureStore, request: LiteraturePdfDownloadRequest) {
	const preparedDownload = await prepareLiteraturePdfDownload(store, request);
	const manager = new OperationConsentManager();
	const preparedOperation = await manager.prepare(preparedDownload.plan);
	const grant = await manager.confirm(
		preparedOperation.operationId,
		preparedOperation.manifestFingerprint,
		"test-user",
	);
	return { preparedDownload, authorization: { manager, grant } };
}

function emptyArxivFeed(): Response {
	return new Response('<?xml version="1.0"?><feed></feed>', { headers: { "content-type": "application/atom+xml" } });
}

describe("downloadLiteraturePdfs", () => {
	it("uses the primary PDF without acquiring later arXiv candidates", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-primary-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({
			identifiers: { doi: "10.5555/saved-link", arxivId: "2501.01234" },
			links: [{ url: "https://example.org/paper.pdf", kind: "pdf", openAccess: true }],
		});
		await store.upsertPaper(record);
		const body = Buffer.from("%PDF-primary");
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "example.org") {
				return new Response(body, { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected acquisition: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(result.downloaded).toHaveLength(1);
		expect(await readFile(result.downloaded[0].blobPath)).toEqual(body);
		expect(result.attempts).toEqual([
			expect.objectContaining({ source: "record-primary", status: "succeeded" }),
			expect.objectContaining({ source: "record-arxiv", status: "skipped" }),
		]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		await expect(
			downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization),
		).rejects.toThrow("already been used");
	});

	it("queries DOI providers only after saved PDF links fail and retains the successful fallback", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-lazy-doi-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({
			identifiers: { doi: "10.5555/lazy.fallback" },
			links: [{ url: "https://publisher.example/paper.pdf", kind: "pdf" }],
		});
		await store.upsertPaper(record);
		let metadataRequests = 0;
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "publisher.example") return new Response("blocked", { status: 403 });
			if (url.hostname === "api.semanticscholar.org") {
				metadataRequests++;
				return Response.json({ externalIds: { DOI: "10.5555/lazy.fallback", ArXiv: "2401.00001" } });
			}
			if (url.hostname === "export.arxiv.org") {
				metadataRequests++;
				return emptyArxivFeed();
			}
			if (url.hostname === "api.openalex.org") {
				metadataRequests++;
				return Response.json({ results: [] });
			}
			if (url.hostname === "arxiv.org") {
				return new Response("%PDF-lazy-fallback", { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected URL: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);

		expect(metadataRequests).toBe(0);
		expect(prepared.preparedDownload.plan.details.deferredDoiFallbackCount).toBe(1);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(metadataRequests).toBeGreaterThan(0);
		expect(result.attempts.map(({ source, status }) => ({ source, status }))).toEqual([
			{ source: "record-primary", status: "failed" },
			{ source: "semantic-scholar-arxiv", status: "succeeded" },
		]);
		expect((await store.getPaper(record.id))?.links).toContainEqual({
			url: "https://arxiv.org/pdf/2401.00001.pdf",
			kind: "pdf",
			openAccess: true,
		});
	});

	it("falls back from a blocked primary link to an existing arXiv identifier", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-arxiv-id-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({
			identifiers: { arxivId: "2501.01234" },
			links: [{ url: "https://publisher.example/paper.pdf", kind: "pdf" }],
		});
		await store.upsertPaper(record);
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "publisher.example") return new Response("forbidden", { status: 403 });
			if (url.hostname === "arxiv.org") {
				return new Response("%PDF-arxiv", { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected URL: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(result.failures).toEqual([]);
		expect(result.downloaded[0]).toMatchObject({ versionKind: "preprint" });
		expect(result.attempts.map(({ source, status }) => ({ source, status }))).toEqual([
			{ source: "record-primary", status: "failed" },
			{ source: "record-arxiv", status: "succeeded" },
		]);
	});

	it("rejects a spoofed PDF content type and continues to arXiv", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-signature-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({
			identifiers: { arxivId: "2501.01234" },
			links: [{ url: "https://publisher.example/paper.pdf", kind: "pdf" }],
		});
		await store.upsertPaper(record);
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "publisher.example") {
				return new Response("<html>access denied</html>", { headers: { "content-type": "application/pdf" } });
			}
			return new Response("%PDF-arxiv", { headers: { "content-type": "application/octet-stream" } });
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(result.failures).toEqual([]);
		expect(result.attempts).toEqual([
			expect.objectContaining({
				source: "record-primary",
				status: "failed",
				reason: "response does not have a PDF file signature",
			}),
			expect.objectContaining({ source: "record-arxiv", status: "succeeded" }),
		]);
	});

	it("freezes an exact DOI to Semantic Scholar arXiv fallback before confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-doi-arxiv-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({
			identifiers: { doi: "10.5555/fallback.test" },
		});
		await store.upsertPaper(record);
		let metadataRequests = 0;
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "api.semanticscholar.org") {
				metadataRequests++;
				return Response.json({ externalIds: { DOI: "10.5555/fallback.test", ArXiv: "2401.00001" } });
			}
			if (url.hostname === "export.arxiv.org") {
				metadataRequests++;
				return emptyArxivFeed();
			}
			if (url.hostname === "api.openalex.org") {
				metadataRequests++;
				return Response.json({ results: [] });
			}
			if (url.hostname === "arxiv.org") {
				return new Response("%PDF-semantic-arxiv", { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected URL: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);
		const metadataAfterPrepare = metadataRequests;
		expect(prepared.preparedDownload.plan.targets).toEqual(
			expect.arrayContaining([expect.objectContaining({ value: "https://arxiv.org/pdf/2401.00001.pdf" })]),
		);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(metadataRequests).toBe(metadataAfterPrepare);
		expect(result.downloaded[0]).toMatchObject({ versionKind: "preprint" });
		expect(result.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: "semantic-scholar-arxiv", status: "succeeded" })]),
		);
	});

	it("extracts a publisher PDF URL when DOI providers return no direct file", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-publisher-meta-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({ identifiers: { doi: "10.3390/math12213431" } });
		await store.upsertPaper(record);
		const pdfUrl = "https://mdpi-res.example/article.pdf";
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "api.semanticscholar.org") {
				return Response.json({
					externalIds: { DOI: "10.3390/math12213431" },
					openAccessPdf: { url: "https://doi.org/10.3390/math12213431", status: "GOLD" },
				});
			}
			if (url.hostname === "export.arxiv.org") return emptyArxivFeed();
			if (url.hostname === "api.openalex.org") return Response.json({ results: [] });
			if (url.hostname === "api.crossref.org") {
				return Response.json({
					message: {
						DOI: "10.3390/math12213431",
						title: ["Paper"],
						URL: "https://doi.org/10.3390/math12213431",
					},
				});
			}
			if (url.hostname === "doi.org") {
				return new Response(`<html><head><meta content="${pdfUrl}" name="citation_pdf_url"></head></html>`, {
					headers: { "content-type": "text/html" },
				});
			}
			if (url.hostname === "mdpi-res.example") {
				return new Response("%PDF-mdpi", { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected URL: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);

		expect(prepared.preparedDownload.papers[0].candidates).toContainEqual({
			url: pdfUrl,
			source: "publisher-landing",
			versionKind: "published",
		});
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);
		expect(result.downloaded).toHaveLength(1);
		expect(result.attempts[0]).toMatchObject({ source: "publisher-landing", status: "succeeded" });
	});

	it("falls back from an MDPI article endpoint to its static published PDF", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-mdpi-static-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({ identifiers: { doi: "10.3390/math12213431" } });
		await store.upsertPaper(record);
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "api.semanticscholar.org") {
				return Response.json({ externalIds: { DOI: "10.3390/math12213431" } });
			}
			if (url.hostname === "export.arxiv.org") return emptyArxivFeed();
			if (url.hostname === "api.openalex.org") return Response.json({ results: [] });
			if (url.hostname === "api.crossref.org") {
				return Response.json({
					message: {
						DOI: "10.3390/math12213431",
						title: ["Paper"],
						"container-title": ["Mathematics"],
						URL: "https://doi.org/10.3390/math12213431",
						link: [{ URL: "https://www.mdpi.com/2227-7390/12/21/3431/pdf" }],
					},
				});
			}
			if (url.hostname === "www.mdpi.com") {
				return new Response("<html>verification required</html>", { headers: { "content-type": "text/html" } });
			}
			if (url.hostname === "mdpi-res.com") {
				return new Response("%PDF-mdpi-static", { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected URL: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);

		expect(prepared.preparedDownload.papers[0].candidates.map((candidate) => candidate.url)).toEqual([
			"https://www.mdpi.com/2227-7390/12/21/3431/pdf",
			"https://mdpi-res.com/d_attachment/mathematics/mathematics-12-03431/article_deploy/mathematics-12-03431.pdf",
		]);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(result.failures).toEqual([]);
		expect(result.attempts.map(({ source, status }) => ({ source, status }))).toEqual([
			{ source: "crossref", status: "failed" },
			{ source: "publisher-derived", status: "succeeded" },
		]);
	});

	it("uses an exact arXiv DOI result when Semantic Scholar has no arXiv identifier", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-arxiv-doi-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({ identifiers: { doi: "10.5555/arxiv.lookup" } });
		await store.upsertPaper(record);
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "api.semanticscholar.org") {
				return Response.json({ externalIds: { DOI: "10.5555/arxiv.lookup" } });
			}
			if (url.hostname === "export.arxiv.org") {
				return new Response(
					"<feed><entry><id>https://arxiv.org/abs/2301.12345</id><arxiv:doi>10.5555/arxiv.lookup</arxiv:doi></entry></feed>",
				);
			}
			if (url.hostname === "api.openalex.org") return Response.json({ results: [] });
			if (url.hostname === "arxiv.org") {
				return new Response("%PDF-arxiv-doi", { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected URL: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(result.attempts[0]).toMatchObject({ source: "arxiv-doi", status: "succeeded" });
	});

	it("continues from failed arXiv and OA candidates until OpenAlex succeeds", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-oa-chain-"));
		const config = defaultPaperAgentConfig();
		config.credentials = { unpaywallEmail: "researcher@example.com" };
		await savePaperAgentConfig(root, config);
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({
			identifiers: { doi: "10.5555/oa.chain" },
			links: [{ url: "https://publisher.example/paper.pdf", kind: "pdf" }],
		});
		await store.upsertPaper(record);
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.hostname === "api.semanticscholar.org") {
				return Response.json({
					externalIds: { DOI: "10.5555/oa.chain", ArXiv: "2402.00002" },
					openAccessPdf: { url: "https://s2.example/paper.pdf", status: "GREEN" },
				});
			}
			if (url.hostname === "export.arxiv.org") return emptyArxivFeed();
			if (url.hostname === "api.unpaywall.org") {
				return Response.json({ best_oa_location: { url_for_pdf: "https://unpaywall.example/paper.pdf" } });
			}
			if (url.hostname === "api.openalex.org") {
				return Response.json({
					results: [
						{
							doi: "https://doi.org/10.5555/oa.chain",
							best_oa_location: { pdf_url: "https://openalex.example/paper.pdf" },
						},
					],
				});
			}
			if (["publisher.example", "arxiv.org", "unpaywall.example"].includes(url.hostname)) {
				return new Response("unavailable", { status: 403 });
			}
			if (url.hostname === "s2.example")
				return new Response("not a pdf", { headers: { "content-type": "text/html" } });
			if (url.hostname === "openalex.example") {
				return new Response("%PDF-openalex", { headers: { "content-type": "application/pdf" } });
			}
			throw new Error(`Unexpected URL: ${url.href}`);
		});
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(result.failures).toEqual([]);
		expect(result.attempts.map(({ source, status }) => ({ source, status }))).toEqual([
			{ source: "record-primary", status: "failed" },
			{ source: "semantic-scholar-arxiv", status: "failed" },
			{ source: "unpaywall", status: "failed" },
			{ source: "semantic-scholar-oa", status: "failed" },
			{ source: "openalex", status: "succeeded" },
		]);
	});

	it("reports every failed candidate without saving a partial version", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-all-fail-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({
			identifiers: { arxivId: "2501.09999" },
			links: [{ url: "https://publisher.example/paper.pdf", kind: "pdf" }],
		});
		await store.upsertPaper(record);
		const fetcher = vi.fn(async () => new Response("blocked", { status: 403 }));
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);
		const result = await downloadLiteraturePdfs(store, request, prepared.preparedDownload, prepared.authorization);

		expect(result.downloaded).toEqual([]);
		expect(result.failures[0]?.reason).toContain("record-primary: HTTP 403");
		expect(result.failures[0]?.reason).toContain("record-arxiv: HTTP 403");
		expect(result.attempts).toHaveLength(2);
		expect(await store.listPaperVersions(record.id)).toEqual([]);
	});

	it("rejects request changes after the frozen candidate manifest was confirmed", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-change-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record = paper({ links: [{ url: "https://example.org/paper.pdf", kind: "pdf" }] });
		await store.upsertPaper(record);
		const fetcher = vi.fn(async () => new Response("%PDF-test", { headers: { "content-type": "application/pdf" } }));
		const request = requestFor(root, record, fetcher);
		const prepared = await authorization(store, request);

		await expect(
			downloadLiteraturePdfs(
				store,
				{ ...request, maxBytesPerFile: 2048 },
				prepared.preparedDownload,
				prepared.authorization,
			),
		).rejects.toThrow("does not match");
	});
});
