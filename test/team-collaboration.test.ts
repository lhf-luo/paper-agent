import { mkdtemp, rm } from "node:fs/promises";
import { fetchWithReviewPreview as fetch } from "./team-http-fixture.ts";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import type { DerivedRecord, PaperRecord } from "../src/literature/domain/literature-types.ts";
import { saveTeamAccess } from "../src/team/infrastructure/team-access-file.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

const temporaryPaths: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function collaborationPaper(id: string): PaperRecord {
	return {
		id,
		title: `Collaboration Paper ${id}`,
		abstract: "Shared by the collaboration suite.",
		authors: ["Collaboration Author"],
		year: 2026,
		identifiers: {},
		links: [{ url: `https://example.org/${id}.pdf`, kind: "pdf", openAccess: true }],
		provenance: [{ provider: "json-import", query: "collaboration", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
	};
}

async function startCollaborationServer() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-team-collab-"));
	temporaryPaths.push(root);
	const server = createTeamCorpusServer({
		root: join(root, "team"),
		identities: [
			{
				name: "alice",
				tokenSha256: hashTeamToken("alice-token"),
				roles: ["reader", "contributor"],
				namespaces: ["security"],
			},
			{
				name: "carol",
				tokenSha256: hashTeamToken("carol-token"),
				roles: ["reader", "contributor"],
				namespaces: ["security"],
			},
			{
				name: "reviewer",
				tokenSha256: hashTeamToken("reviewer-token"),
				roles: ["reader", "reviewer"],
				namespaces: ["security"],
			},
		],
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
	const serverUrl = `http://127.0.0.1:${address.port}`;
	const call = (path: string, token: string, init: RequestInit = {}) =>
		fetch(`${serverUrl}/v1/namespaces/security${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		});
	return { root, serverUrl, call };
}

async function connectAs(root: string, serverUrl: string, token: string, identity: string) {
	await saveTeamAccess(root, { serverUrl, namespace: "security", token, identity });
	return new PaperAgentApplication({ projectRoot: root });
}

describe("team collaboration flows", () => {
	it("submits personal derived records and surfaces them to reviewers as pending", async () => {
		const { root, serverUrl, call } = await startCollaborationServer();
		const application = await connectAs(root, serverUrl, "alice-token", "alice");
		try {
			const store = application.personalStore();
			const paper = collaborationPaper("collab-derived-paper");
			await store.upsertPaper(paper);
			const derived: DerivedRecord = {
				key: "collab-derived",
				paperId: paper.id,
				operation: "skim-card",
				inputHashes: ["a".repeat(64)],
				pipelineVersion: "research-workspace-v1",
				normalizedConfig: {},
				result: { finding: "derived-submitted", localArtifact: "D:\\private\\card.md" },
				createdAt: "2026-01-02T00:00:00.000Z",
			};
			await store.putDerived(derived);

			const input = { keys: [derived.key] };
			const plan = await application.prepareTeamDerivedProposal(input);
			expect(plan.kind).toBe("team-proposal");
			// Absolute paths are flagged but never rewritten.
			expect(JSON.stringify(plan.details.warnings)).toContain("absolute path retained");
			const grant = await application.confirmOperation(plan.operationId, plan.manifestFingerprint);
			await expect(application.proposeTeamDerived(input, grant)).resolves.toMatchObject({
				entries: [{ record: { key: derived.key }, review: { status: "team-proposed" } }],
			});

			const reviewerView = (await (await call("/derived?pending=true", "reviewer-token")).json()) as {
				entries: Array<{ record: { key: string }; review: { status: string } }>;
			};
			expect(reviewerView.entries).toMatchObject([
				{ record: { key: derived.key }, review: { status: "team-proposed" } },
			]);
			// A reader must not see the pending derived record.
			expect(await (await call("/derived", "alice-token")).json()).toMatchObject({ entries: [] });
		} finally {
			await application.close();
		}
	});

	it("shows contributors their own pending proposals while keeping the full queue reviewer-only", async () => {
		const { root, serverUrl, call } = await startCollaborationServer();
		await call("/proposals", "alice-token", {
			method: "POST",
			body: JSON.stringify({ records: [collaborationPaper("collab-mine-paper")] }),
		});
		const application = await connectAs(root, serverUrl, "alice-token", "alice");
		try {
			const overview = await application.teamOverview();
			expect(overview).toMatchObject({
				connected: true,
				identity: { name: "alice" },
				capabilities: { canContribute: true, canReview: false },
				myProposals: [{ id: "collab-mine-paper" }],
			});
			// Writers cannot see the reviewer queue without `mine=true`.
			expect((await call("/proposals", "alice-token")).status).toBe(403);
			expect((await call("/proposals", "reviewer-token")).status).toBe(200);
			const mine = (await (await call("/proposals?mine=true", "alice-token")).json()) as {
				records: Array<{ id: string }>;
			};
			expect(mine.records.map((record) => record.id)).toEqual(["collab-mine-paper"]);
		} finally {
			await application.close();
		}
	});

	it("lets a contributor withdraw an untouched proposal but rejects other people's and reviewed ones", async () => {
		const { root, serverUrl, call } = await startCollaborationServer();
		await call("/proposals", "alice-token", {
			method: "POST",
			body: JSON.stringify({
				records: [collaborationPaper("collab-withdraw-a"), collaborationPaper("collab-withdraw-b")],
			}),
		});
		const application = await connectAs(root, serverUrl, "alice-token", "alice");
		try {
			// Another contributor cannot withdraw alice's proposal.
			expect(
				(
					await call("/proposals/withdraw", "carol-token", {
						method: "POST",
						body: JSON.stringify({ paperIds: ["collab-withdraw-b"] }),
					})
				).status,
			).toBe(400);

			const input = { paperIds: ["collab-withdraw-a"] };
			const plan = await application.prepareTeamWithdraw(input);
			expect(plan.kind).toBe("team-write");
			const grant = await application.confirmOperation(plan.operationId, plan.manifestFingerprint);
			await expect(application.withdrawTeamProposals(input, grant)).resolves.toMatchObject({
				withdrawn: ["collab-withdraw-a"],
			});
			expect((await call("/papers/collab-withdraw-a", "reviewer-token")).status).toBe(404);

			// A reviewed proposal can no longer be withdrawn.
			await call("/reviews", "reviewer-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["collab-withdraw-b"], decision: "team-approved" }),
			});
			expect(
				(
					await call("/proposals/withdraw", "alice-token", {
						method: "POST",
						body: JSON.stringify({ paperIds: ["collab-withdraw-b"] }),
					})
				).status,
			).toBe(400);

			// A pending revision of an approved record can be withdrawn by its proposer; the approved copy is untouched.
			// (The merge keeps the longer abstract, so the revised text must be longer to become a content change.)
			const revision = collaborationPaper("collab-withdraw-b");
			revision.abstract = "Revised by alice with a substantially longer abstract than the original text.";
			expect(
				(await call("/proposals", "alice-token", { method: "POST", body: JSON.stringify({ records: [revision] }) }))
					.status,
			).toBe(200);
			const mine = (await (await call("/proposals?mine=true", "alice-token")).json()) as { records: PaperRecord[] };
			expect(mine.records).toMatchObject([
				{ id: "collab-withdraw-b", abstract: revision.abstract, curation: { teamReview: { revision: true } } },
			]);
			expect(
				(
					await call("/proposals/withdraw", "alice-token", {
						method: "POST",
						body: JSON.stringify({ paperIds: ["collab-withdraw-b"] }),
					})
				).status,
			).toBe(200);
			expect(await (await call("/papers/collab-withdraw-b", "reviewer-token")).json()).toMatchObject({
				abstract: "Shared by the collaboration suite.",
				curation: { teamReview: { status: "team-approved" } },
			});
			expect(
				((await (await call("/proposals", "reviewer-token")).json()) as { records: unknown[] }).records,
			).toEqual([]);

			const events = (await (await call("/events?limit=50", "reviewer-token")).json()) as {
				events: Array<{ action: string }>;
			};
			expect(events.events.map((event) => event.action)).toContain("paper.withdraw");
		} finally {
			await application.close();
		}
	});
});
