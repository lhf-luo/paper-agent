import { createHash } from "node:crypto";
import { fetchWithReviewPreview as fetch } from "./team-http-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";
import type { TeamPageSnapshot } from "../src/team/domain/team-corpus-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function pageSnapshot(overrides: Partial<TeamPageSnapshot> = {}): TeamPageSnapshot {
	const kind = overrides.kind ?? "note";
	const sourceId = overrides.sourceId ?? "note-uaf";
	const markdown = overrides.markdown ?? "# UAF 检测总结\n\n关键结论 [E1]。\n";
	const base: TeamPageSnapshot = {
		key: `${kind}.${sourceId}`,
		sourceId,
		kind,
		title: "UAF 阅读笔记",
		markdown,
		contentHash: createHash("sha256").update(markdown).digest("hex"),
		revision: 3,
		paperIds: ["paper-team-server"],
		createdAt: "2026-09-12T00:00:00.000Z",
	};
	return { ...base, ...overrides, key: overrides.key ?? base.key };
}

describe("team knowledge pages", () => {
	it("keeps pending pages invisible to readers until a reviewer approves them", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-pages-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "alice",
					tokenSha256: hashTeamToken("alice-token"),
					roles: ["reader", "contributor"],
					namespaces: ["security"],
				},
				{
					name: "bob",
					tokenSha256: hashTeamToken("bob-token"),
					roles: ["reader", "reviewer"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});

			const proposed = await call("/pages", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [pageSnapshot()] }),
			});
			expect(proposed.status).toBe(200);
			const proposedBody = (await proposed.json()) as {
				entries: Array<{ snapshot: { key: string }; review: { status: string; proposedBy: string } }>;
			};
			expect(proposedBody.entries[0]?.review.status).toBe("team-proposed");
			expect(proposedBody.entries[0]?.review.proposedBy).toBe("alice");
			const pageKey = proposedBody.entries[0].snapshot.key;

			const readerView = await call("/pages", "alice-token");
			expect(readerView.status).toBe(200);
			expect(((await readerView.json()) as { entries: unknown[] }).entries).toHaveLength(0);

			const reviewerPending = await call("/pages?pending=true", "bob-token");
			expect(((await reviewerPending.json()) as { entries: unknown[] }).entries).toHaveLength(1);

			const readerCannotReview = await call("/pages/reviews", "alice-token", {
				method: "POST",
				body: JSON.stringify({ keys: ["note.note-uaf"], decision: "team-approved" }),
			});
			expect(readerCannotReview.status).toBe(403);

			const approved = await call("/pages/reviews", "bob-token", {
				method: "POST",
				body: JSON.stringify({ keys: [pageKey], decision: "team-approved", reason: "证据充分" }),
			});
			expect(approved.status).toBe(200);
			expect(
				((await approved.json()) as { entries: Array<{ review: { status: string } }> }).entries[0]?.review.status,
			).toBe("team-approved");

			const readerAfterApproval = await call("/pages", "alice-token");
			expect(((await readerAfterApproval.json()) as { entries: unknown[] }).entries).toHaveLength(1);

			const stats = await call("/stats", "alice-token");
			expect(await stats.json()).toMatchObject({ pageCount: 1 });
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("keeps the approval when identical content is re-proposed and resets it when content changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-pages-repropose-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
			identities: [
				{
					name: "alice",
					tokenSha256: hashTeamToken("alice-token"),
					roles: ["reader", "contributor", "reviewer"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});

			const initialProposal = await call("/pages", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [pageSnapshot()] }),
			});
			const pageKey = ((await initialProposal.json()) as { entries: Array<{ snapshot: { key: string } }> })
				.entries[0].snapshot.key;
			await call("/pages/reviews", "alice-token", {
				method: "POST",
				body: JSON.stringify({ keys: [pageKey], decision: "team-approved" }),
			});

			const identical = await call("/pages", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [pageSnapshot()] }),
			});
			expect(
				((await identical.json()) as { entries: Array<{ review: { status: string } }> }).entries[0]?.review.status,
			).toBe("team-approved");

			const changed = pageSnapshot({ markdown: "# UAF 检测总结 v2\n\n修订后的结论。\n" });
			const revised = await call("/pages", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [changed] }),
			});
			expect(
				((await revised.json()) as { entries: Array<{ review: { status: string } }> }).entries[0]?.review.status,
			).toBe("team-proposed");

			const rejected = await call("/pages/reviews", "alice-token", {
				method: "POST",
				body: JSON.stringify({ keys: [pageKey], decision: "team-rejected" }),
			});
			expect(
				((await rejected.json()) as { entries: Array<{ review: { status: string } }> }).entries[0]?.review.status,
			).toBe("team-rejected");

			const audit = await call("/events", "alice-token");
			const actions = ((await audit.json()) as { events: Array<{ action: string }> }).events.map(
				(event) => event.action,
			);
			expect(actions).toContain("page.propose");
			expect(actions).toContain("page.review");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("rejects malformed page snapshots and role violations", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-pages-invalid-"));
		temporaryPaths.push(root);
		const server = createTeamCorpusServer({
			root: join(root, "corpus"),
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
					roles: ["reader"],
					namespaces: ["security"],
				},
			],
		});
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
			const base = `http://127.0.0.1:${address.port}/v1/namespaces/security`;
			const call = (path: string, token: string, init: RequestInit = {}) =>
				fetch(base + path, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				});

			const mismatchedKey = pageSnapshot({ key: "wiki.note-uaf" });
			const mismatched = await call("/pages", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [mismatchedKey] }),
			});
			expect(mismatched.status).toBe(400);

			const badHash = pageSnapshot({ contentHash: "not-a-hash" });
			const invalid = await call("/pages", "alice-token", {
				method: "POST",
				body: JSON.stringify({ records: [badHash] }),
			});
			expect(invalid.status).toBe(400);

			const readerProposal = await call("/pages", "carol-token", {
				method: "POST",
				body: JSON.stringify({ records: [pageSnapshot()] }),
			});
			expect(readerProposal.status).toBe(403);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
