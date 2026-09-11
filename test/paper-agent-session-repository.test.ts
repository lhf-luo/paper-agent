import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentSessionRepository } from "../src/agent/infrastructure/paper-agent-session-repository.ts";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PaperAgentSessionRepository", () => {
	it("opens the paper session repository after preparing a fresh personal store", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-fresh-start-"));
		temporaryPaths.push(root);
		const application = new PaperAgentApplication({
			projectRoot: root,
			dataRoot: join(root, ".paper-agent"),
		});
		try {
			await application.initialize();
			const store = application.personalStore();
			await store.initialize();
			const databasePath = store.databasePath;
			await expect(access(databasePath)).resolves.toBeUndefined();
			const repository = new PaperAgentSessionRepository(databasePath);
			repository.close();
		} finally {
			await application.close();
		}
	});

	it("stores paper conversations and queues runtime cleanup when the paper is deleted", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-reader-session-"));
		temporaryPaths.push(root);
		const store = new LiteratureStore(resolveCorpusRoot(root, "personal", "default"), "personal", "default");
		await store.upsertPaper({
			id: "paper-reader",
			title: "Reader paper",
			authors: ["Reader Author"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: "2026-09-06T00:00:00.000Z" }],
			mergedFrom: [],
		});
		const repository = new PaperAgentSessionRepository(store.databasePath);
		try {
			repository.save({
				id: "reader-session",
				title: "阅读：Reader paper",
				mode: "persistent",
				context: { kind: "paper", namespace: "default", paperId: "paper-reader" },
				createdAt: "2026-09-06T00:00:00.000Z",
				updatedAt: "2026-09-06T00:01:00.000Z",
				messages: [
					{
						id: "assistant-message",
						role: "assistant",
						content: "I inspected the paper.",
						status: "complete",
						createdAt: "2026-09-06T00:00:30.000Z",
					},
				],
				tools: [
					{
						id: "tool-call",
						assistantMessageId: "assistant-message",
						name: "read",
						status: "succeeded",
						input: "paper.pdf",
						output: "ok",
						startedAt: "2026-09-06T00:00:10.000Z",
						finishedAt: "2026-09-06T00:00:20.000Z",
					},
				],
			});

			expect(repository.restore()).toEqual([
				expect.objectContaining({
					id: "reader-session",
					context: { kind: "paper", namespace: "default", paperId: "paper-reader" },
					messages: [expect.objectContaining({ id: "assistant-message" })],
					tools: [expect.objectContaining({ id: "tool-call", assistantMessageId: "assistant-message" })],
				}),
			]);

			await store.deletePapers(["paper-reader"]);
			expect(repository.restore()).toEqual([]);
			expect(repository.pendingCleanupIds()).toEqual(["reader-session"]);
		} finally {
			repository.close();
		}
	});
});
