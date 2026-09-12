import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TeamReviewResource, TeamReviewSnapshot } from "../src/team/domain/team-corpus-types.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const timestamp = "2026-09-12T00:00:00.000Z";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-review-integrity-"));
	const server = createTeamCorpusServer({
		root,
		identities: [
			{
				name: "alice",
				tokenSha256: hashTeamToken("fixture-alice"),
				roles: ["reader", "contributor"],
				namespaces: ["lab"],
			},
			{
				name: "bob",
				tokenSha256: hashTeamToken("fixture-bob"),
				roles: ["reader", "contributor"],
				namespaces: ["lab"],
			},
			{
				name: "reviewer",
				tokenSha256: hashTeamToken("fixture-reviewer"),
				roles: ["reader", "reviewer"],
				namespaces: ["lab"],
			},
			{ name: "reader", tokenSha256: hashTeamToken("fixture-reader"), roles: ["reader"], namespaces: ["lab"] },
			{ name: "admin", tokenSha256: hashTeamToken("fixture-admin"), roles: ["admin"] },
		],
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fixture port");
	const origin = `http://127.0.0.1:${address.port}`;
	const base = `${origin}/v1/namespaces/lab`;
	const call = (path: string, data?: unknown, actor = "reviewer") =>
		fetch(base + path, {
			method: data === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer fixture-${actor}`, "content-type": "application/json" },
			body: data === undefined ? undefined : JSON.stringify(data),
		});
	const preview = async (resource: TeamReviewResource, ids: string[]) => {
		const response = await call("/reviews/preview", { resource, ids });
		expect(response.status).toBe(200);
		return ((await response.json()) as { entries: TeamReviewSnapshot[] }).entries;
	};
	const review = async (
		resource: TeamReviewResource,
		ids: string[],
		decision = "team-approved",
		entries?: TeamReviewSnapshot[],
	) => {
		const snapshot = entries ?? (await preview(resource, ids));
		return call(resource === "papers" ? "/reviews" : `/${resource}/reviews`, {
			[resource === "papers" || resource === "artifacts" ? "paperIds" : "keys"]: ids,
			decision,
			reason: "private reviewer rationale",
			expectedVersions: Object.fromEntries(snapshot.map((entry) => [entry.id, entry.version])),
		});
	};
	cleanups.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	return { root, origin, base, call, preview, review };
}
function paper(revision: number) {
	return {
		id: "paper-one",
		title: "Shared research",
		abstract: "More detail ".repeat(revision),
		identifiers: { doi: "10.1234/team" },
		authors: ["Researcher"],
		links: [{ kind: "pdf", url: "https://example.org/paper.pdf" }],
		provenance: [{ provider: "local-pdf", query: "fixture", retrievedAt: timestamp }],
		mergedFrom: [],
	};
}
function page(revision: number, sourceNamespace = "default") {
	const markdown = `# Research\n\nVersion ${revision}`;
	return {
		key: "wiki.overview",
		sourceId: "overview",
		sourceNamespace,
		kind: "wiki",
		title: "Research overview",
		markdown,
		contentHash: createHash("sha256").update(markdown).digest("hex"),
		revision,
		paperIds: [],
		createdAt: timestamp,
	};
}

describe("team review content integrity", () => {
	it.each<TeamReviewResource>(["papers", "derived", "artifacts", "pages"])(
		"preserves published %s and rejects approval of a changed preview",
		async (resource) => {
			const f = await fixture();
			const propose = async (revision: number) => {
				const response =
					resource === "papers"
						? await f.call("/proposals", { records: [paper(revision)] }, "alice")
						: resource === "derived"
							? await f.call(
									"/derived",
									{
										records: [
											{
												key: "skim-one",
												paperId: "paper-one",
												operation: "skim",
												inputHashes: [],
												pipelineVersion: "1",
												normalizedConfig: {},
												createdAt: timestamp,
												result: { revision },
											},
										],
									},
									"alice",
								)
							: resource === "artifacts"
								? await f.call(
										"/artifacts",
										{
											paperId: "paper-one",
											manifest: {
												schemaVersion: 1,
												pdfPath: "paper.pdf",
												pdfSha256: "a".repeat(64),
												discoveredAt: timestamp,
												candidates: [],
												acquisitions: [],
												paperIdentity: { title: `Version ${revision}` },
											},
										},
										"alice",
									)
								: await f.call("/pages", { records: [page(revision)] }, "alice");
				expect(response.status).toBe(200);
				const body = (await response.json()) as { entries?: Array<{ snapshot?: { key: string } }> };
				return resource === "pages"
					? body.entries![0].snapshot!.key
					: resource === "derived"
						? "skim-one"
						: "paper-one";
			};
			const id = await propose(1);
			const path = resource === "papers" ? `/papers/${id}` : `/${resource}`;
			expect(
				(
					await f.call(resource === "papers" ? "/reviews" : `/${resource}/reviews`, {
						[resource === "papers" || resource === "artifacts" ? "paperIds" : "keys"]: [id],
						decision: "team-approved",
					})
				).status,
			).toBe(428);
			expect((await f.review(resource, [id])).status).toBe(200);
			const published = await (await f.call(path, undefined, "reader")).json();
			await propose(2);
			expect(await (await f.call(path, undefined, "reader")).json()).toEqual(published);
			const stale = await f.preview(resource, [id]);
			await propose(3);
			expect((await f.review(resource, [id], "team-approved", stale)).status).toBe(409);
			expect(await (await f.call(path, undefined, "reader")).json()).toEqual(published);
			expect((await f.review(resource, [id], "team-rejected")).status).toBe(200);
			expect(await (await f.call(path, undefined, "reader")).json()).toEqual(published);
		},
	);
	it("isolates page origins by member and namespace and preserves them across rename", async () => {
		const f = await fixture();
		const propose = async (actor: string, sourceNamespace = "default") => {
			const response = await f.call("/pages", { records: [page(1, sourceNamespace)] }, actor);
			expect(response.status).toBe(200);
			return ((await response.json()) as { entries: Array<{ snapshot: { key: string } }> }).entries[0].snapshot.key;
		};
		const alice = await propose("alice");
		expect(new Set([alice, await propose("bob"), await propose("alice", "another-project")]).size).toBe(3);
		const who = await fetch(`${f.origin}/v1/whoami`, { headers: { authorization: "Bearer fixture-alice" } });
		const identity = ((await who.json()) as { identity: { id: string } }).identity;
		expect(
			(
				await fetch(`${f.origin}/v1/admin/identities/${identity.id}/rename`, {
					method: "POST",
					headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" },
					body: JSON.stringify({ name: "renamed" }),
				})
			).ok,
		).toBe(true);
		expect(await propose("alice")).toBe(alice);
	});
	it("preflights a whole review batch before changing any decision", async () => {
		const f = await fixture();
		await f.call("/pages", { records: [page(1), { ...page(1), key: "wiki.second", sourceId: "second" }] }, "alice");
		const list = (
			(await (await f.call("/pages?pending=true")).json()) as { entries: Array<{ snapshot: { key: string } }> }
		).entries;
		const ids = list.map((entry) => entry.snapshot.key);
		const preview = await f.preview("pages", ids);
		preview[1].version = "0".repeat(64);
		expect((await f.review("pages", ids, "team-approved", preview)).status).toBe(409);
		expect(await (await f.call("/pages", undefined, "reader")).json()).toEqual({ entries: [] });
	});
	it("keeps audit details and unreviewed attachment versions private", async () => {
		const f = await fixture();
		await f.call("/proposals", { records: [paper(1)] }, "alice");
		const upload = async (label: string) => {
			const bytes = Buffer.from(`%PDF-1.7\n${label}\n`);
			const sha = createHash("sha256").update(bytes).digest("hex");
			const response = await fetch(`${f.base}/blobs/${sha}`, {
				method: "PUT",
				headers: {
					authorization: "Bearer fixture-alice",
					"content-type": "application/pdf",
					"x-paper-id": "paper-one",
					"x-source-url": "https://example.org/paper.pdf",
					"x-final-url": `https://example.org/${label}.pdf`,
					"x-retrieved-at": timestamp,
				},
				body: bytes,
			});
			expect(response.status).toBe(200);
			return sha;
		};
		const first = await upload("first");
		expect((await f.call(`/blobs/${first}`, undefined, "reader")).status).toBe(404);
		expect((await f.review("papers", ["paper-one"])).status).toBe(200);
		expect((await f.call(`/blobs/${first}`, undefined, "reader")).status).toBe(200);
		const second = await upload("second");
		expect((await f.call("/papers/paper-one", undefined, "reader")).status).toBe(200);
		expect((await f.call(`/blobs/${second}`, undefined, "reader")).status).toBe(404);
		const versions = (await (await f.call("/papers/paper-one/versions", undefined, "reader")).json()) as {
			versions: Array<{ sha256: string }>;
		};
		expect(versions.versions.map((version) => version.sha256)).toEqual([first]);
		expect((await f.review("papers", ["paper-one"], "team-rejected")).status).toBe(200);
		expect((await f.call(`/blobs/${first}`, undefined, "reader")).status).toBe(200);
		expect((await f.call(`/blobs/${second}`, undefined, "reader")).status).toBe(404);
		expect((await f.call("/events", undefined, "reader")).status).toBe(403);
		const stats = await (await f.call("/stats", undefined, "reader")).json();
		expect(stats).not.toHaveProperty("latestAuditEvent");
		expect(stats).not.toHaveProperty("pendingPapers");
		expect(JSON.stringify(stats)).not.toContain("private reviewer rationale");
	});
});
