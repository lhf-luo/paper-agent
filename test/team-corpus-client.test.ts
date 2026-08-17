import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature-store.ts";
import type { PaperRecord } from "../src/literature-types.ts";
import {
	registerTeamCorpusClientTool,
	sanitizePaperRecordForTeamProposal,
	searchRemoteTeamCorpus,
} from "../src/tools/team-corpus-client.ts";
import { createTeamCorpusServer, hashTeamToken } from "../src/team-corpus-server.ts";

const temporaryPaths: string[] = [];
const originalUrl = process.env.PAPER_AGENT_TEAM_SERVER_URL;
const originalToken = process.env.PAPER_AGENT_TEAM_TOKEN;

afterEach(async () => {
	if (originalUrl === undefined) delete process.env.PAPER_AGENT_TEAM_SERVER_URL;
	else process.env.PAPER_AGENT_TEAM_SERVER_URL = originalUrl;
	if (originalToken === undefined) delete process.env.PAPER_AGENT_TEAM_TOKEN;
	else process.env.PAPER_AGENT_TEAM_TOKEN = originalToken;
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paper(): PaperRecord {
	return {
		id: "paper-client-e2e",
		title: "Neural Binary Similarity",
		authors: ["Alice Researcher"],
		year: 2025,
		identifiers: {},
		links: [],
		provenance: [{ provider: "local-pdf", query: "import", retrievedAt: "2026-01-01T00:00:00Z" }],
		mergedFrom: [],
		curation: {
			tags: ["binary-analysis"],
			userNotes: [{ id: "private", text: "do not share", author: "alice", createdAt: "2026-01-01T00:00:00Z" }],
		},
	};
}

describe("team corpus client", () => {
	it("removes private curation before a proposal reaches the network boundary", () => {
		const sanitized = sanitizePaperRecordForTeamProposal({
			...paper(),
			curation: {
				...paper().curation!,
				screening: {
					status: "include",
					updatedBy: "alice",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			},
		});
		expect(sanitized.curation).toEqual({ tags: ["binary-analysis"], userNotes: [] });
		expect(JSON.stringify(sanitized)).not.toContain("do not share");
		expect(sanitized.curation?.screening).toBeUndefined();
	});

	it("proposes a personal record and searches it through the authenticated loopback service", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-client-"));
		temporaryPaths.push(root);
		const personalNamespace = "alice";
		const personal = new LiteratureStore(
			resolveCorpusRoot(root, "personal", personalNamespace, join(root, "local-corpus")),
			"personal",
			personalNamespace,
		);
		await personal.upsertPaper(paper());

		const server = createTeamCorpusServer({
			root: join(root, "team-corpus"),
			identities: [
				{
					name: "admin",
					tokenSha256: hashTeamToken("admin-token"),
					roles: ["admin"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			process.env.PAPER_AGENT_TEAM_SERVER_URL = `http://127.0.0.1:${address.port}/`;
			process.env.PAPER_AGENT_TEAM_TOKEN = "admin-token";

			let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
				registerTeamCorpusClientTool({
				registerTool(candidate: { execute: (...args: any[]) => Promise<any> }) {
					tool = candidate;
				},
				} as unknown as ExtensionAPI);
				if (!tool) throw new Error("team client tool was not registered");
				let confirmations = 0;
				await tool.execute(
				"call-propose",
				{
					action: "propose",
					namespace: "security",
					personal_namespace: personalNamespace,
					personal_corpus_root: join(root, "local-corpus"),
				},
				undefined,
				undefined,
					{
						cwd: root,
						hasUI: true,
						ui: {
							confirm: async (_title: string, detail: string) => {
								confirmations++;
								expect(detail).toContain("Manifest:");
								expect(detail).not.toContain("do not share");
								return true;
							},
						},
					},
				);
				expect(confirmations).toBe(1);
			const result = await searchRemoteTeamCorpus({ namespace: "security", query: "binary" });
			expect(result.hits).toHaveLength(1);
			expect(result.hits[0].record.curation?.userNotes).toEqual([]);
				expect(result.hits[0].record.curation?.teamReview).toMatchObject({
				status: "team-proposed",
				proposedBy: "admin",
				});
				await expect(
					tool.execute(
						"call-no-ui",
						{
							action: "review",
							namespace: "security",
							paper_ids: [paper().id],
							review_decision: "team-approved",
						},
						undefined,
						undefined,
						{ cwd: root, hasUI: false },
					),
				).rejects.toThrow("interactive user confirmation");
			await expect(
				tool.execute(
					"call-missing",
					{
						action: "propose",
						namespace: "security",
						personal_namespace: personalNamespace,
						personal_corpus_root: join(root, "local-corpus"),
						paper_ids: ["missing-paper"],
					},
					undefined,
					undefined,
					{ cwd: root },
				),
			).rejects.toThrow("does not contain requested paper ids");
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	});

	it("rejects cleartext HTTP for non-loopback hosts before sending a request", async () => {
		process.env.PAPER_AGENT_TEAM_SERVER_URL = "http://example.com/";
		process.env.PAPER_AGENT_TEAM_TOKEN = "secret";
		await expect(searchRemoteTeamCorpus({ namespace: "default" })).rejects.toThrow(
			"plain HTTP is allowed only for loopback",
		);
	});

	it("rejects unsafe namespaces before constructing a request URL", async () => {
		process.env.PAPER_AGENT_TEAM_SERVER_URL = "http://127.0.0.1:1/";
		process.env.PAPER_AGENT_TEAM_TOKEN = "secret";
		await expect(searchRemoteTeamCorpus({ namespace: ".." })).rejects.toThrow("safe 1-64 character identifier");
		await expect(searchRemoteTeamCorpus({ namespace: "security." })).rejects.toThrow(
			"safe 1-64 character identifier",
		);
	});
});
