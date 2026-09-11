import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import type { CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function importExecutor(): CommandExecutor {
	return {
		exec: async (command, args) => {
			const path = args.find((value) => value.toLowerCase().endsWith(".pdf"));
			const source = path ? await readFile(path).catch(() => Buffer.from("")) : Buffer.from("");
			const missing = source.includes("MISSING");
			if (command === "pdfinfo") {
				return {
					stdout: missing ? "" : "Title: Imported Paper\nAuthor: Alice Researcher; Bob Scientist\n",
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			if (command === "pdftotext") {
				return {
					stdout: missing ? "" : "Imported Paper\nAlice Researcher, Bob Scientist\nAbstract\nFixture",
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			return { stdout: "", stderr: "OCR unavailable", code: 1, killed: false };
		},
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-web-local-import-"));
	temporaryPaths.push(root);
	const config = defaultPaperAgentConfig();
	config.search.providers = [];
	await savePaperAgentConfig(root, config);
	const staticRoot = join(root, "dist", "web");
	await mkdir(staticRoot, { recursive: true });
	await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
	const application = new PaperAgentApplication({
		projectRoot: root,
		dataRoot: join(root, ".paper-agent"),
		executor: importExecutor(),
	});
	const server = await startLocalWebServer(application, { staticRoot });
	return { application, root, server };
}

async function createBatch(serverUrl: string, namespace: string, collectionId?: string) {
	const response = await fetch(`${serverUrl}/api/library/local-imports`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ namespace, collectionId }),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return (await response.json()) as { id: string };
}

async function upload(serverUrl: string, batchId: string, filename: string, body: string) {
	return fetch(`${serverUrl}/api/library/local-imports/${encodeURIComponent(batchId)}/files`, {
		method: "POST",
		headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent(filename) },
		body,
	});
}

describe("personal library local PDF imports", () => {
	it("previews multiple PDFs and atomically imports valid records into the current nested collection", async () => {
		const { application, server } = await fixture();
		try {
			const parent = await application.createLibraryCollection("Systems", undefined, "lab");
			const child = await application.createLibraryCollection("Compilers", parent.id, "lab");
			const batch = await createBatch(server.url, "lab", child.id);
			const ready = await upload(server.url, batch.id, "ready.pdf", "%PDF-1.4\nREADY\n%%EOF\n");
			expect(ready.status, await ready.clone().text()).toBe(201);
			expect(await ready.json()).toMatchObject({ filename: "ready.pdf", status: "ready" });
			const missing = await upload(server.url, batch.id, "missing.pdf", "%PDF-1.4\nMISSING\n%%EOF\n");
			expect(missing.status).toBe(201);
			expect(await missing.json()).toMatchObject({
				filename: "missing.pdf",
				status: "needs_metadata",
				needsMetadata: { missingFields: ["title", "authors"] },
			});

			const preparedResponse = await fetch(`${server.url}/api/library/local-imports/${batch.id}/prepare`, {
				method: "POST",
			});
			const prepared = (await preparedResponse.json()) as {
				acceptedCount: number;
				needsMetadataCount: number;
				collection: { id: string };
				files: Array<{ action?: string }>;
				operation: { operationId: string; manifestFingerprint: string };
			};
			expect(preparedResponse.status).toBe(200);
			expect(prepared).toMatchObject({ acceptedCount: 1, needsMetadataCount: 1, collection: { id: child.id } });
			expect(prepared.files[0].action).toBe("created");

			const confirmation = await fetch(`${server.url}/api/operations/confirm`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(prepared.operation),
			});
			const grant = await confirmation.json();
			const executed = await fetch(`${server.url}/api/library/local-imports/${batch.id}/execute`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ grant }),
			});
			expect(executed.status, await executed.clone().text()).toBe(200);
			const records = await application.personalStore("lab").listPapers();
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ title: "Imported Paper", collectionIds: [child.id] });
			expect(await application.personalStore("lab").listPaperVersions(records[0].id)).toHaveLength(1);
			expect(await application.personalStore().listPapers()).toEqual([]);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("rejects invalid uploads, identifies unchanged imports, and supports cancellation", async () => {
		const { application, root, server } = await fixture();
		try {
			const stagingRoot = join(root, ".paper-agent", "runtime", "local-pdf-imports");
			await mkdir(join(stagingRoot, "stale-batch"), { recursive: true });
			await writeFile(join(stagingRoot, "stale-batch", "orphan.pdf"), "%PDF-1.4\n");
			const invalidBatch = await createBatch(server.url, "default");
			expect(await readdir(stagingRoot)).not.toContain("stale-batch");
			const invalid = await upload(server.url, invalidBatch.id, "page.pdf", "<html>login</html>");
			expect(invalid.status).toBe(400);
			await fetch(`${server.url}/api/library/local-imports/${invalidBatch.id}`, { method: "DELETE" });
			expect(await readdir(stagingRoot)).toEqual([]);

			const importOnce = async () => {
				const batch = await createBatch(server.url, "default");
				await upload(server.url, batch.id, "paper.pdf", "%PDF-1.4\nREADY\n%%EOF\n");
				const prepared = await (
					await fetch(`${server.url}/api/library/local-imports/${batch.id}/prepare`, { method: "POST" })
				).json();
				const grant = await (
					await fetch(`${server.url}/api/operations/confirm`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(prepared.operation),
					})
				).json();
				await fetch(`${server.url}/api/library/local-imports/${batch.id}/execute`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ grant }),
				});
				return prepared;
			};
			await importOnce();
			const second = await importOnce();
			expect(second.files[0].action).toBe("unchanged");
			const [paper] = await application.personalStore().listPapers();
			expect(await application.personalStore().listPaperVersions(paper.id)).toHaveLength(1);
			expect(await readdir(stagingRoot)).toEqual([]);
		} finally {
			await server.close();
			await application.close();
		}
	});
});
