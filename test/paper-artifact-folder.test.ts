import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import type { ArtifactManifest, PaperRecord } from "../src/literature/domain/literature-types.ts";
import type { CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("personal paper Artifact folder", () => {
	it("reads availability from SQLite and opens only the controlled paper Artifact directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-artifact-folder-"));
		temporaryPaths.push(root);
		const commands: Array<{ command: string; args: string[]; options?: { detached?: boolean } }> = [];
		const executor: CommandExecutor = {
			exec: async (command, args, options) => {
				commands.push({ command, args, options });
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		};
		const application = new PaperAgentApplication({ projectRoot: root, executor });
		const paper: PaperRecord = {
			id: "paper-artifact-folder",
			title: "Artifact folder fixture",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: "2026-08-31T00:00:00.000Z" }],
			mergedFrom: [],
		};
		const store = application.personalStore();
		await store.upsertPaper(paper);
		expect(await application.paperDetails(paper.id)).toMatchObject({
			artifact: { available: false, count: 0 },
		});
		await expect(application.openPaperArtifactFolder(paper.id)).rejects.toThrow("没有可用的本地 Artifact");

		const artifactRoot = join(root, ".paper-agent", "files", "personal", "default", paper.id, "artifacts");
		const repository = join(artifactRoot, "fixture-repository");
		await mkdir(repository, { recursive: true });
		await writeFile(join(repository, "README.md"), "fixture");
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath: join(root, "fixture.pdf"),
			pdfSha256: "a".repeat(64),
			discoveredAt: "2026-08-31T00:00:00.000Z",
			candidates: [
				{
					id: "artifact-folder-fixture",
					url: "https://github.com/example/fixture",
					kind: "repository",
					host: "github.com",
					sources: [{ method: "external-url", url: "https://github.com/example/fixture" }],
					confidence: "medium",
				},
			],
			acquisitions: [
				{
					candidateId: "artifact-folder-fixture",
					sourceUrl: "https://github.com/example/fixture",
					status: "cloned",
					localPath: repository,
					retrievedAt: "2026-08-31T00:01:00.000Z",
				},
			],
		};
		await store.saveArtifactManifest(manifest, paper.id);

		expect(await application.paperDetails(paper.id)).toMatchObject({
			artifact: { available: true, count: 1 },
		});
		const server = await startLocalWebServer(application, {
			staticRoot: root,
		});
		try {
			const response = await fetch(`${server.url}/api/papers/${paper.id}/artifacts/open?namespace=default`, {
				method: "POST",
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ opened: true, artifactCount: 1 });
		} finally {
			await server.close();
			await application.close();
		}
		expect(commands).toHaveLength(1);
		expect(commands[0].args).toEqual([artifactRoot]);
		expect(commands[0].options?.detached).toBe(true);
	});

	it("opens the directory containing the selected registered PDF version", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-folder-"));
		temporaryPaths.push(root);
		const commands: Array<{ command: string; args: string[]; options?: { detached?: boolean } }> = [];
		const executor: CommandExecutor = {
			exec: async (command, args, options) => {
				commands.push({ command, args, options });
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		};
		const application = new PaperAgentApplication({ projectRoot: root, executor });
		const paper: PaperRecord = {
			id: "paper-pdf-folder",
			title: "PDF folder fixture",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: "2026-09-07T00:00:00.000Z" }],
			mergedFrom: [],
		};
		const store = application.personalStore();
		await store.upsertPaper(paper);
		const body = Buffer.from("%PDF-1.4\nfixture\n%%EOF\n");
		const sha256 = createHash("sha256").update(body).digest("hex");
		const staged = await store.putBlob(body);
		await store.savePaperVersion({
			paperId: paper.id,
			sourceUrl: "https://example.org/fixture.pdf",
			finalUrl: "https://example.org/fixture.pdf",
			retrievedAt: "2026-09-07T00:00:00.000Z",
			sha256,
			bytes: body.length,
			blobPath: staged.path,
			contentType: "application/pdf",
			versionKind: "published",
			isPreferred: true,
		});
		const [version] = await store.listPaperVersions(paper.id);
		const server = await startLocalWebServer(application, { staticRoot: root });
		try {
			const response = await fetch(
				`${server.url}/api/papers/${paper.id}/pdf/${sha256}/folder/open?namespace=default`,
				{ method: "POST" },
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ opened: true });
		} finally {
			await server.close();
			await application.close();
		}
		expect(commands).toHaveLength(1);
		expect(commands[0].args).toEqual([dirname(version.blobPath)]);
		expect(commands[0].options?.detached).toBe(true);
	});
});
