import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import type { ArtifactManifest, PaperRecord, PaperVersion } from "../src/literature/domain/literature-types.ts";

const temporaryPaths: string[] = [];

function paper(id: string, title: string): PaperRecord {
	return {
		id,
		title,
		authors: ["Ada Researcher"],
		identifiers: {},
		links: [],
		provenance: [{ provider: "local-pdf", query: "test", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
	};
}

afterEach(async () => {
	for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("personal SQLite corpus", () => {
	it("keeps the persisted paper id stable and resolves the incoming id as an alias", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-stable-id-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const original = { ...paper("paper-original", "Stable Paper"), identifiers: { arxivId: "2501.12345" } };
		await store.upsertPaper(original);
		const enriched = {
			...original,
			id: "doi-new-id",
			identifiers: { doi: "10.1000/stable", arxivId: "2501.12345" },
		};
		await store.upsertPaper(enriched);

		expect((await store.getPaper(original.id))?.id).toBe(original.id);
		expect((await store.getPaper(enriched.id))?.id).toBe(original.id);
	});

	it("keeps formal and preprint publication versions with the formal version preferred", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-publication-versions-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const record = {
			...paper("paper-versions", "Versioned Paper"),
			identifiers: { doi: "10.1000/versioned", arxivId: "2501.12345" },
			links: [
				{ url: "https://arxiv.org/pdf/2501.12345.pdf", kind: "pdf" as const },
				{ url: "https://publisher.example/paper.pdf", kind: "pdf" as const },
			],
		};
		await store.upsertPaper(record);

		const versions = await store.listPublicationVersions(record.id);
		expect(versions.map(({ kind, isPreferred }) => ({ kind, isPreferred }))).toEqual([
			{ kind: "published", isPreferred: true },
			{ kind: "preprint", isPreferred: false },
		]);
		expect(versions.find((version) => version.kind === "preprint")?.links).toEqual([
			{ url: "https://arxiv.org/pdf/2501.12345.pdf", kind: "pdf" },
		]);
	});

	it("deduplicates repeated paper URLs before writing SQLite link rows", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-link-deduplication-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const url = "https://dl.acm.org/doi/pdf/10.1145/3180155.3180225";
		const record = {
			...paper("paper-links", "Duplicate Link Paper"),
			links: [
				{ url, kind: "landing" as const },
				{ url, kind: "pdf" as const, openAccess: true },
			],
		};

		await expect(store.upsertPaper(record)).resolves.toBe("created");
		expect((await store.getPaper(record.id))?.links).toEqual([{ url, kind: "pdf", openAccess: true }]);
	});



	it("adds a canonical DOI link while retaining provider links", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-doi-link-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const record = {
			...paper("paper-doi-link", "Canonical Link Paper"),
			identifiers: { doi: "DOI:10.1145/1234.5678" },
			links: [{ url: "https://openalex.org/W123", kind: "landing" as const }],
		};

		await store.upsertPaper(record);
		expect((await store.getPaper(record.id))?.links).toEqual([
			{ url: "https://doi.org/10.1145/1234.5678", kind: "doi" },
			{ url: "https://openalex.org/W123", kind: "landing" },
		]);
	});

	it("stores readable PDF names, verifies content, and renames files with the title", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-sqlite-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const record = paper("paper-readable", "Compiler: Testing? at Scale");
		await store.upsertPaper(record);

		const body = new TextEncoder().encode("%PDF-1.7\nreadable fixture");
		const blob = await store.putBlob(body);
		const version: PaperVersion = {
			paperId: record.id,
			sourceUrl: "https://example.test/paper.pdf",
			finalUrl: "https://example.test/paper.pdf",
			retrievedAt: "2026-01-02T00:00:00.000Z",
			sha256: blob.sha256,
			bytes: body.byteLength,
			blobPath: blob.path,
			contentType: "application/pdf",
			versionKind: "published",
			isPreferred: true,
		};
		await store.savePaperVersion(version);
		expect(await store.paperDeletionImpact([record.id])).toEqual({
			pdfVersionCount: 1,
			pdfBytes: body.byteLength,
			derivedRecordCount: 0,
		});

		expect(basename(version.blobPath)).toBe("Compiler Testing at Scale.pdf");
		expect(await readFile(version.blobPath)).toEqual(Buffer.from(body));
		expect(await store.readPaperVersionBlob(record.id, blob.sha256)).toEqual(Buffer.from(body));
		await stat(join(root, ".paper-agent", "corpus", "personal.sqlite"));
		await expect(stat(join(store.root, "index"))).rejects.toMatchObject({ code: "ENOENT" });

		await store.upsertPaper({ ...record, title: "Renamed Compiler Paper" });
		const renamed = (await store.listPaperVersions(record.id))[0];
		expect(basename(renamed.blobPath)).toBe("Renamed Compiler Paper.pdf");
		await expect(stat(version.blobPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(renamed.blobPath)).toEqual(Buffer.from(body));
	});

	it("isolates namespaces inside one personal database", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-namespaces-"));
		temporaryPaths.push(root);
		const alice = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const bob = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		await alice.upsertPaper(paper("alice-paper", "Alice Paper"));
		await bob.upsertPaper(paper("bob-paper", "Bob Paper"));

		expect((await alice.listPapers()).map((record) => record.id)).toEqual(["alice-paper", "bob-paper"]);
		expect((await bob.listPapers()).map((record) => record.id)).toEqual(["alice-paper", "bob-paper"]);
		await stat(join(root, ".paper-agent", "corpus", "personal.sqlite"));
	});

	it("persists artifact manifests scoped to their paper", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-manifest-"));
		temporaryPaths.push(root);
		const alice = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const bob = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		await alice.upsertPaper(paper("paper-a", "Artifact Paper"));
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath: "C:/papers/artifact.pdf",
			pdfSha256: "a".repeat(64),
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [],
			acquisitions: [],
		};
		await expect(alice.saveArtifactManifest(manifest, "missing")).rejects.toThrow(/Paper not found/);
		const id = await alice.saveArtifactManifest(manifest, "paper-a");
		expect(id).toBe(`artifact-${"a".repeat(24)}`);
		expect(await alice.listArtifactManifests("paper-a")).toEqual([manifest]);
		expect(await bob.listArtifactManifests()).toEqual([manifest]);
	});

	it("deletes a paper's PDF and artifact directory with its database records", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-delete-artifacts-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal"), "personal");
		const record = paper("paper-delete", "Disposable Paper");
		await store.upsertPaper(record);
		const paperDirectory = join(root, ".paper-agent", "files", "personal", record.id);
		const artifactDirectory = join(paperDirectory, "artifacts", "DisposableProject");
		await mkdir(artifactDirectory, { recursive: true });
		await writeFile(join(artifactDirectory, "README.md"), "artifact");
		await store.saveArtifactManifest(
			{
				schemaVersion: 1,
				pdfPath: join(paperDirectory, "Disposable Paper.pdf"),
				pdfSha256: "d".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [],
				acquisitions: [],
			},
			record.id,
		);

		expect(await store.deletePapers([record.id])).toMatchObject({ deleted: [record.id], blobWarnings: [] });
		await expect(stat(paperDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await store.getPaper(record.id)).toBeUndefined();
		expect(await store.listArtifactManifests(record.id)).toEqual([]);
	});


});
