import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function teamPaper(id: string, title: string): PaperRecord {
	return {
		id,
		title,
		authors: ["Lifecycle Author"],
		year: 2026,
		identifiers: {},
		links: [],
		provenance: [{ provider: "local-pdf", query: "lifecycle", retrievedAt: "2026-01-01T00:00:00.000Z" }],
		mergedFrom: [],
	};
}

interface Harness {
	origin: string;
	base: string;
	call: (path: string, token: string, init?: RequestInit) => Promise<Response>;
	adminCall: (path: string, token?: string, init?: RequestInit) => Promise<Response>;
	close: () => Promise<void>;
}

async function startServer(input: { seeds?: Parameters<typeof createTeamCorpusServer>[0]["identities"] } = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-team-lifecycle-"));
	temporaryPaths.push(root);
	const server = createTeamCorpusServer({
		root: join(root, "corpus"),
		identities: input.seeds ?? [{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] }],
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
	const origin = `http://127.0.0.1:${address.port}`;
	const call = (path: string, token: string, init: RequestInit = {}) =>
		fetch(`${origin}/v1/namespaces/security${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
		});
	return {
		origin,
		base: `${origin}/v1/namespaces/security`,
		call,
		adminCall: (path: string, token = "admin-token", init: RequestInit = {}) =>
			fetch(origin + path, {
				...init,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
			}),
		close: () =>
			server.listening
				? new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
				: Promise.resolve(),
	};
}

describe("team identity lifecycle and access controls", () => {
	it("rejects an expired identity with 401", async () => {
		const harness = await startServer({
			seeds: [
				{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] },
				{
					name: "former",
					tokenSha256: hashTeamToken("former-token"),
					roles: ["reader"],
					namespaces: ["security"],
					expiresAt: "2020-01-01T00:00:00.000Z",
				},
			],
		});
		try {
			expect((await harness.adminCall("/v1/whoami", "former-token")).status).toBe(401);
			expect((await harness.adminCall("/v1/whoami", "admin-token")).status).toBe(200);
		} finally {
			await harness.close();
		}
	});

	it("blocks a banned identity, restores it on unban, and only deletes revoked members", async () => {
		const harness = await startServer();
		try {
			const created = (await (
				await harness.adminCall("/v1/admin/identities", "admin-token", {
					method: "POST",
					body: JSON.stringify({ name: "member", roles: ["reader"], namespaces: ["security"] }),
				})
			).json()) as { token: string; identity: { id: string } };
			const token = created.token;
			expect((await harness.adminCall("/v1/whoami", token)).status).toBe(200);

			expect(
				(
					await harness.adminCall(`/v1/admin/identities/${created.identity.id}/ban`, "admin-token", {
						method: "POST",
						body: JSON.stringify({ reason: "policy" }),
					})
				).status,
			).toBe(200);
			expect((await harness.adminCall("/v1/whoami", token)).status).toBe(401);
			expect(
				(
					await harness.adminCall(`/v1/admin/identities/${created.identity.id}/unban`, "admin-token", {
						method: "POST",
						body: "{}",
					})
				).status,
			).toBe(200);
			expect((await harness.adminCall("/v1/whoami", token)).status).toBe(200);

			// Deleting a still-active member is rejected.
			expect(
				(
					await harness.adminCall(`/v1/admin/identities/${created.identity.id}/delete`, "admin-token", {
						method: "POST",
						body: "{}",
					})
				).status,
			).toBe(400);
			expect(
				(
					await harness.adminCall(`/v1/admin/identities/${created.identity.id}/revoke`, "admin-token", {
						method: "POST",
						body: "{}",
					})
				).status,
			).toBe(200);
			expect((await harness.adminCall("/v1/whoami", token)).status).toBe(401);
			expect(
				(
					await harness.adminCall(`/v1/admin/identities/${created.identity.id}/delete`, "admin-token", {
						method: "POST",
						body: "{}",
					})
				).status,
			).toBe(200);
			const listed = (await (await harness.adminCall("/v1/admin/identities")).json()) as {
				identities: Array<{ name: string }>;
			};
			expect(listed.identities.map((entry) => entry.name)).not.toContain("member");
		} finally {
			await harness.close();
		}
	});

	it("refuses to let the active administrator revoke, ban, or delete themselves", async () => {
		const harness = await startServer();
		try {
			const me = (await (await harness.adminCall("/v1/whoami")).json()) as { identity: { id: string } };
			for (const action of ["revoke", "ban", "delete"]) {
				const response = await harness.adminCall(`/v1/admin/identities/${me.identity.id}/${action}`, "admin-token", {
					method: "POST",
					body: "{}",
				});
				expect(response.status, `self ${action} must be rejected`).toBeGreaterThanOrEqual(400);
				expect(response.status).toBeLessThan(500);
			}
		} finally {
			await harness.close();
		}
	});

	it("paginates audit events newest-first with a cursor and hides pending derived records from readers", async () => {
		const harness = await startServer({
			seeds: [
				{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] },
				{ name: "reader", tokenSha256: hashTeamToken("reader-token"), roles: ["reader"], namespaces: ["security"] },
			],
		});
		try {
			await harness.call("/proposals", "admin-token", {
				method: "POST",
				body: JSON.stringify({ records: [teamPaper("lifecycle-paper", "Lifecycle Paper")] }),
			});
			await harness.call("/reviews", "admin-token", {
				method: "POST",
				body: JSON.stringify({ paperIds: ["lifecycle-paper"], decision: "team-approved" }),
			});
			await harness.call("/derived", "admin-token", {
				method: "POST",
				body: JSON.stringify({
					records: [
						{
							key: "lifecycle-derived",
							paperId: "lifecycle-paper",
							operation: "skim-card",
							inputHashes: ["a".repeat(64)],
							pipelineVersion: "v1",
							createdAt: "2026-01-02T00:00:00.000Z",
							result: { finding: "pending" },
						},
					],
				}),
			});

			const pageOne = (await (await harness.call("/events?limit=2", "admin-token")).json()) as {
				events: Array<{ action: string }>;
				nextCursor?: string;
			};
			expect(pageOne.events).toHaveLength(2);
			expect(pageOne.nextCursor).toBe("2");
			const pageTwo = (await (
				await harness.call(`/events?limit=2&cursor=${pageOne.nextCursor}`, "admin-token")
			).json()) as { events: Array<{ action: string }> };
			expect(pageTwo.events).toHaveLength(1);
			// Newest-first ordering: the most recent write (derived.propose) leads the first page.
			expect(pageOne.events[0]?.action).toBe("derived.propose");
			expect(pageOne.events[1]?.action).toBe("paper.review");
			expect(pageTwo.events[0]?.action).toBe("paper.propose");

			// `pending=true` is a reviewer-only affordance; a plain reader still sees only approved records.
			const readerPending = (await (await harness.call("/derived?pending=true", "reader-token")).json()) as {
				entries: unknown[];
			};
			expect(readerPending.entries).toHaveLength(0);
			const reviewerPending = (await (await harness.call("/derived?pending=true", "admin-token")).json()) as {
				entries: unknown[];
			};
			expect(reviewerPending.entries).toHaveLength(1);
		} finally {
			await harness.close();
		}
	});

	it("returns 404 for a paper id that does not exist", async () => {
		const harness = await startServer({
			seeds: [
				{ name: "admin", tokenSha256: hashTeamToken("admin-token"), roles: ["admin"] },
				{ name: "reader", tokenSha256: hashTeamToken("reader-token"), roles: ["reader"], namespaces: ["security"] },
			],
		});
		try {
			expect((await harness.call("/papers/does-not-exist", "reader-token")).status).toBe(404);
			expect((await harness.call("/papers/does-not-exist/versions", "reader-token")).status).toBe(404);
		} finally {
			await harness.close();
		}
	});
});
