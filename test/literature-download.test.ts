import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	downloadLiteraturePdfs,
	type LiteraturePdfDownloadRequest,
	literaturePdfDownloadPlan,
} from "../src/literature-download.ts";
import { LiteratureStore } from "../src/literature-store.ts";
import type { PaperRecord } from "../src/literature-types.ts";
import { OperationConsentManager } from "../src/operation-consent.ts";

async function authorization(store: LiteratureStore, request: LiteraturePdfDownloadRequest) {
	const manager = new OperationConsentManager();
	const prepared = await manager.prepare(await literaturePdfDownloadPlan(store, request));
	const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "test-user");
	return { manager, grant };
}

describe("downloadLiteraturePdfs", () => {
	it("requires an exact one-time grant before storing a PDF", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-download-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const record: PaperRecord = {
			id: "paper-1",
			title: "Paper",
			authors: ["Researcher"],
			identifiers: {},
			links: [{ url: "https://example.org/paper.pdf", kind: "pdf", openAccess: true }],
			provenance: [{ provider: "local-pdf", query: "test", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await store.upsertPaper(record);
		const body = Buffer.from("%PDF-fixture");
		const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": "application/pdf" } }));
		const request: LiteraturePdfDownloadRequest = {
			paperIds: [record.id],
			maxFiles: 1,
			maxBytesPerFile: 1024,
			concurrency: 1,
			fetcher,
			resolver: async () => [{ address: "93.184.216.34" }],
		};
		const grant = await authorization(store, request);
		const result = await downloadLiteraturePdfs(store, request, grant);

		expect(result.downloaded).toHaveLength(1);
		expect(await readFile(result.downloaded[0].blobPath)).toEqual(body);
		await expect(downloadLiteraturePdfs(store, request, grant)).rejects.toThrow("already been used");
	});

	it("rejects a request changed after confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-download-change-"));
		const store = new LiteratureStore(join(root, "corpus"), "personal", "default");
		const request: LiteraturePdfDownloadRequest = {
			maxFiles: 1,
			maxBytesPerFile: 1024,
			concurrency: 1,
		};
		const grant = await authorization(store, request);

		await expect(downloadLiteraturePdfs(store, { ...request, maxBytesPerFile: 2048 }, grant)).rejects.toThrow(
			"does not match",
		);
	});
});
