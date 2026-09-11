import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { registerCollectionTools } from "../src/literature/presentation/collection-tools.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function registeredTool() {
	let tool: any;
	registerCollectionTools({
		registerTool(candidate: { name: string }) {
			if (candidate.name === "get_personal_library_paper") tool = candidate;
		},
	} as unknown as ExtensionAPI);
	return tool;
}

function paper(): PaperRecord {
	return {
		id: "paper-uaf",
		title: "Binary-level Directed Fuzzing for Use-After-Free Vulnerabilities",
		abstract: "A directed binary fuzzing technique.",
		authors: ["Ada Researcher", "Bob Systems"],
		year: 2025,
		venue: "Security Conference",
		identifiers: { doi: "10.1000/uaf.1", openAlexId: "W123" },
		links: [
			{ kind: "doi", url: "https://doi.org/10.1000/uaf.1" },
			{ kind: "pdf", url: "https://example.org/uaf.pdf", openAccess: true },
			{ kind: "artifact", url: "https://github.com/example/uaf" },
		],
		provenance: [
			{
				provider: "openalex",
				query: "Binary-level Directed Fuzzing",
				retrievedAt: "2026-09-01T00:00:00.000Z",
				providerRecordId: "W123",
			},
		],
		mergedFrom: [],
		curation: {
			tags: ["UAF", "binary fuzzing"],
			userNotes: [
				{ id: "note-1", text: "Read evaluation section.", author: "User", createdAt: "2026-09-01T00:00:00.000Z" },
			],
		},
	};
}

describe("get_personal_library_paper", () => {
	it("returns stored links, collection paths, PDF versions, and artifacts for an exact title", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-personal-query-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		const parent = await store.createCollection("Security");
		const child = await store.createCollection("UAF", parent.id);
		await store.upsertPaper({ ...paper(), collectionIds: [child.id] });
		const pdfPath = join(root, "uaf.pdf");
		const pdfBody = Buffer.from("%PDF-1.4\nquery fixture\n", "utf8");
		const pdfSha256 = createHash("sha256").update(pdfBody).digest("hex");
		await writeFile(pdfPath, pdfBody);
		await store.savePaperVersion({
			paperId: "paper-uaf",
			sourceUrl: "https://example.org/uaf.pdf",
			finalUrl: "https://cdn.example.org/uaf.pdf",
			retrievedAt: "2026-09-02T00:00:00.000Z",
			sha256: pdfSha256,
			bytes: pdfBody.byteLength,
			blobPath: pdfPath,
			contentType: "application/pdf",
			versionKind: "published",
			isPreferred: true,
		});
		await store.saveArtifactManifest(
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256,
				discoveredAt: "2026-09-03T00:00:00.000Z",
				candidates: [
					{
						id: "artifact-1",
						url: "https://github.com/example/uaf",
						kind: "repository",
						host: "github.com",
						sources: [{ method: "external-url" }],
						confidence: "high",
					},
				],
				acquisitions: [
					{
						candidateId: "artifact-1",
						sourceUrl: "https://github.com/example/uaf",
						status: "cloned",
						localPath: join(root, "artifacts", "uaf"),
						retrievedAt: "2026-09-03T00:00:01.000Z",
					},
				],
			},
			"paper-uaf",
		);

		const result = await registeredTool().execute(
			"query-paper",
			{ query: "Binary-level Directed Fuzzing for Use-After-Free Vulnerabilities" },
			undefined,
			undefined,
			{ cwd: root },
		);

		expect(result.details.status).toBe("found");
		expect(result.details.paper).toMatchObject({
			collections: [{ path: ["Security", "UAF"] }],
			remotePdfLinks: [{ url: "https://example.org/uaf.pdf", kind: "pdf", openAccess: true }],
			localPdfVersions: [{ versionKind: "published", isPreferred: true }],
			artifacts: {
				links: [{ url: "https://github.com/example/uaf", kind: "artifact" }],
				latestAcquisitions: [{ status: "cloned" }],
			},
		});
		expect(result.content[0].text).toContain("Remote PDF download links: 1");
		expect(result.content[0].text).toContain("https://example.org/uaf.pdf");
		expect(result.content[0].text).toContain("Security / UAF");
	});

	it("does not turn an approximate title into a selected paper", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-personal-query-candidate-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		await store.upsertPaper(paper());

		const result = await registeredTool().execute(
			"query-paper",
			{ query: "Binary-level Directed Fuzzing" },
			undefined,
			undefined,
			{ cwd: root },
		);

		expect(result.details).toMatchObject({ status: "not-found" });
		expect(result.details.candidates).toHaveLength(1);
		expect(result.content[0].text).toContain("retry with paper_id");
	});
});
