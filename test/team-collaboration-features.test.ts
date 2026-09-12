import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamCorpusClient } from "../src/team/application/team-corpus-client.ts";
import type { TeamContentRef, TeamReviewResource } from "../src/team/domain/team-corpus-types.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";
import { handleTeamCollaborationTool } from "../src/team/presentation/team-collaboration-tools.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const at = "2026-09-12T00:00:00.000Z";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-collaboration-features-"));
	const server = createTeamCorpusServer({
		root,
		identities: [
			{
				id: "u-fixture-alice",
				name: "Alice",
				tokenSha256: hashTeamToken("fixture-alice"),
				roles: ["reader", "contributor"],
				namespaces: ["lab"],
			},
			{
				id: "u-fixture-bob",
				name: "Bob",
				tokenSha256: hashTeamToken("fixture-bob"),
				roles: ["reader", "contributor"],
				namespaces: ["lab"],
			},
			{
				id: "u-fixture-reviewer",
				name: "Reviewer",
				tokenSha256: hashTeamToken("fixture-reviewer"),
				roles: ["reader", "reviewer"],
				namespaces: ["lab"],
			},
			{
				id: "u-fixture-reader",
				name: "Reader",
				tokenSha256: hashTeamToken("fixture-reader"),
				roles: ["reader"],
				namespaces: ["lab"],
			},
		],
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	const client = (name: string) =>
		new TeamCorpusClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: `fixture-${name}` });
	const alice = client("alice"),
		bob = client("bob"),
		reviewer = client("reviewer"),
		reader = client("reader");
	cleanups.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const propose = async (resource: TeamReviewResource, revision = 1, id = "one"): Promise<TeamContentRef> => {
		if (resource === "papers")
			await alice.proposePapers("lab", [
				{
					id,
					title: `Paper ${id}`,
					abstract: "Longer finding ".repeat(revision),
					authors: ["A"],
					identifiers: { doi: `10.1234/${id}` },
					links: [{ kind: "pdf", url: "https://example.org/paper.pdf" }],
					provenance: [{ provider: "local-pdf", query: "fixture", retrievedAt: at }],
					mergedFrom: [],
				},
			]);
		else if (resource === "derived")
			await alice.proposeDerived("lab", [
				{
					key: id,
					paperId: "one",
					operation: "skim",
					inputHashes: [],
					pipelineVersion: "1",
					normalizedConfig: {},
					createdAt: at,
					result: { revision },
				},
			]);
		else if (resource === "artifacts")
			await alice.proposeArtifact("lab", id, {
				schemaVersion: 1,
				pdfPath: "paper.pdf",
				pdfSha256: "a".repeat(64),
				discoveredAt: at,
				candidates: [],
				acquisitions: [],
				paperIdentity: { title: `Revision ${revision}` },
			});
		else {
			const markdown = `# ${id}\n\nFull text needle-${id} revision ${revision}`;
			const result = await alice.proposePages("lab", [
				{
					key: `note.${id}`,
					kind: "note",
					sourceId: id,
					sourceNamespace: "default",
					title: `Page ${id}`,
					markdown,
					revision,
					contentHash: createHash("sha256").update(markdown).digest("hex"),
					paperIds: [],
					createdAt: at,
				},
			]);
			id = result.entries[0].snapshot.key;
		}
		return { resource, id };
	};
	const approve = async (ref: TeamContentRef) => {
		const { entries } = await reviewer.previewReview("lab", ref.resource, [ref.id]);
		const ids = [ref.id];
		const args = ["lab", ids, "team-approved", "checked", { [ref.id]: entries[0].version }] as const;
		if (ref.resource === "papers") return reviewer.reviewPapers(...args);
		if (ref.resource === "pages") return reviewer.reviewPages(...args);
		if (ref.resource === "derived") return reviewer.reviewDerived(...args);
		return reviewer.reviewArtifacts(...args);
	};
	return { root, alice, bob, reviewer, reader, propose, approve };
}

describe("team collaboration and knowledge reuse contracts", () => {
	it("does not let a reused display name adopt another member's legacy page", async () => {
		const f = await fixture();
		const directory = join(f.root, "lab", "knowledge", "pages");
		await mkdir(directory, { recursive: true });
		const snapshot = {
			key: "note.one",
			kind: "note" as const,
			sourceId: "one",
			title: "Legacy author",
			markdown: "Original legacy content",
			contentHash: createHash("sha256").update("Original legacy content").digest("hex"),
			revision: 1,
			paperIds: [],
			createdAt: at,
			createdBy: "Bob",
		};
		await writeFile(
			join(directory, "note.one.json"),
			JSON.stringify({
				snapshot,
				review: { status: "team-approved", proposedBy: "Bob", proposedById: "u-retired-bob", proposedAt: at },
			}),
		);
		const result = await f.bob.proposePages("lab", [{ ...snapshot, title: "New member content" }]);
		expect(result.entries[0].snapshot.key).not.toBe("note.one");
		expect((await f.reader.listPages("lab")).entries).toMatchObject([{ snapshot: { title: "Legacy author" } }]);
	});
	it("exposes readable Agent content and does not post feedback after authorization is cancelled", async () => {
		const f = await fixture();
		const ref = await f.propose("pages");
		const read = await handleTeamCollaborationTool(
			{ action: "read_content", review_resource: ref.resource, entry_ids: [ref.id], pending: true },
			f.alice,
			"lab",
			process.cwd(),
			async () => {
				throw new Error("Unexpected write authorization");
			},
		);
		expect(read?.content[0].text).toContain("Full text needle-one");
		await expect(
			handleTeamCollaborationTool(
				{ action: "comment", review_resource: ref.resource, entry_ids: [ref.id], comment: "Must not be posted" },
				f.alice,
				"lab",
				process.cwd(),
				async (plan) => {
					expect(plan.details).toHaveProperty("preview");
					throw new Error("Cancelled by user");
				},
			),
		).rejects.toThrow("Cancelled by user");
		expect((await f.alice.discussion("lab", ref)).comments).toEqual([]);
	});
	it.each<TeamReviewResource>(["papers", "derived", "artifacts", "pages"])(
		"tracks %s outcomes, protects others' proposals, and preserves publication on withdrawal",
		async (resource) => {
			const f = await fixture();
			const ref = await f.propose(resource);
			expect((await f.alice.contributions("lab", { mine: true })).entries).toMatchObject([
				{ ...ref, status: "pending" },
			]);
			expect((await f.bob.contributions("lab", { mine: true })).entries).toEqual([]);
			await expect(f.bob.discussion("lab", ref)).rejects.toMatchObject({ status: 404 });
			await f.approve(ref);
			expect((await f.alice.notifications("lab")).unread).toBe(1);
			await f.propose(resource, 2);
			const pending = await f.alice.readContent("lab", ref, { pending: true });
			await expect(
				f.bob.changeCollaboration("lab", { ...ref, action: "withdraw", expectedVersion: pending.version }),
			).rejects.toThrow();
			await f.alice.changeCollaboration("lab", { ...ref, action: "withdraw", expectedVersion: pending.version });
			expect((await f.reader.readContent("lab", ref)).content).toBeTruthy();
			expect((await f.alice.contributions("lab", { mine: true })).entries.map((entry) => entry.status)).toContain(
				"withdrawn",
			);
			await f.propose(resource, 3);
			const current = await f.reviewer.readContent("lab", ref, { pending: true });
			await f.reviewer.changeCollaboration("lab", {
				...ref,
				action: "request-changes",
				expectedVersion: current.version,
				text: "Add reproducible evidence",
			});
			expect((await f.alice.contributions("lab", { mine: true })).entries[0]).toMatchObject({
				status: "changes-requested",
				reason: "Add reproducible evidence",
			});
			expect((await f.reader.readContent("lab", ref)).content).toBeTruthy();
		},
	);

	it("binds comments and assignments to discussion versions and keeps notifications private", async () => {
		const f = await fixture();
		const ref = await f.propose("pages");
		const first = await f.alice.discussion("lab", ref);
		await f.alice.changeCollaboration("lab", {
			...ref,
			action: "comment",
			text: "Please check the method",
			expectedVersion: first.version,
		});
		await expect(
			f.alice.changeCollaboration("lab", {
				...ref,
				action: "comment",
				text: "stale",
				expectedVersion: first.version,
			}),
		).rejects.toMatchObject({ status: 409 });
		const discussion = await f.reviewer.discussion("lab", ref);
		await f.reviewer.changeCollaboration("lab", {
			...ref,
			action: "assign",
			assigneeId: "u-fixture-reviewer",
			expectedVersion: discussion.version,
		});
		expect((await f.alice.discussion("lab", ref)).assignedTo?.id).toBe("u-fixture-reviewer");
		await f.approve(ref);
		const notices = await f.alice.notifications("lab");
		expect(notices.entries[0].targetId).toBe(ref.id);
		await expect(f.bob.readNotifications("lab", [notices.entries[0].id])).rejects.toMatchObject({ status: 404 });
		await f.alice.readNotifications(
			"lab",
			notices.entries.map((entry) => entry.id),
		);
		expect((await f.alice.notifications("lab")).unread).toBe(0);
		await expect(f.reader.contributions("lab")).rejects.toMatchObject({ status: 403 });
	});

	it("searches complete page text with pagination, loads bodies on demand, and curates published topics", async () => {
		const f = await fixture();
		const refs = [];
		for (const id of ["one", "two", "three"]) {
			const ref = await f.propose("pages", 1, id);
			await f.approve(ref);
			refs.push(ref);
		}
		await f.propose("pages", 1, "private");
		const page = await f.reader.searchContent("lab", { resource: "pages", limit: 2 });
		expect(page.entries).toHaveLength(2);
		expect(page.nextCursor).toBe("2");
		expect(page.total).toBe(3);
		expect(page.entries[0]).not.toHaveProperty("content");
		expect(page.entries[0]).not.toHaveProperty("markdown");
		expect(
			(await f.reader.searchContent("lab", { resource: "pages", cursor: page.nextCursor, limit: 2 })).entries,
		).toHaveLength(1);
		expect((await f.reader.searchContent("lab", { query: "needle-two" })).entries).toHaveLength(1);
		expect((await f.reader.searchContent("lab", { query: "needle-private" })).entries).toEqual([]);
		await expect(f.reader.changeTopic("lab", { id: "topic", title: "Methods", entries: refs })).rejects.toMatchObject(
			{ status: 403 },
		);
		await f.reviewer.changeTopic("lab", { id: "topic", title: "Methods", entries: refs.slice(0, 1) });
		expect((await f.reader.searchContent("lab", { topicId: "topic" })).entries).toHaveLength(1);
		await expect(
			f.reviewer.changeTopic("lab", { id: "topic", title: "Overwrite", entries: refs }),
		).rejects.toMatchObject({ status: 409 });
	});
});
