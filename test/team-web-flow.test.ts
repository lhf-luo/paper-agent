import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null) continue;
		const stopped = once(child, "exit");
		child.stdin.write("stop\n");
		const timer = setTimeout(() => child.kill(), 5_000);
		try {
			await stopped;
		} finally {
			clearTimeout(timer);
		}
	}
});

async function fixture() {
	const child = spawn(process.execPath, [resolve("scripts/team-ui-fixture.ts")], {
		cwd: process.cwd(),
		stdio: "pipe",
		env: { ...process.env, PAPER_AGENT_TEAM_ACCESS_LOG: "off" },
	});
	children.push(child);
	const urls = await new Promise<Record<string, string>>((done, reject) => {
		let output = "",
			errors = "";
		const timer = setTimeout(
			() => reject(new Error(`Native team fixture did not start: ${errors.slice(-2000)}`)),
			30_000,
		);
		child.stderr.on("data", (chunk) => {
			errors += String(chunk);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Native fixture exited: ${code}; ${errors.slice(-2000)}`));
		});
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			for (const line of output.split("\n")) {
				try {
					const value = JSON.parse(line);
					if (value.isolated && value.urls) {
						clearTimeout(timer);
						done(value.urls);
						return;
					}
				} catch {
					/* Wait for a complete fixture line. */
				}
			}
		});
	});
	const request = async (actor: string, path: string, body?: unknown, method = "POST") => {
		const response = await fetch(
			new URL(path, urls[actor]),
			body === undefined
				? {}
				: { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		);
		return { status: response.status, body: (await response.json()) as any };
	};
	const call = async (actor: string, path: string, body?: unknown, method?: string) => {
		const result = await request(actor, path, body, method);
		expect(result.status, JSON.stringify(result.body)).toBe(200);
		return result.body;
	};
	const grant = async (actor: string, plan: { operationId: string; manifestFingerprint: string }) =>
		call(actor, "/api/operations/confirm", {
			operationId: plan.operationId,
			manifestFingerprint: plan.manifestFingerprint,
		});
	const mutate = async (actor: string, path: string, input: Record<string, unknown>) => {
		const plan = await call(actor, `${path}/prepare`, input);
		return call(actor, `${path}/execute`, { ...input, grant: await grant(actor, plan) });
	};
	return { request, call, grant, mutate };
}

describe("native Node team Web API flow", () => {
	it("uses concrete versions across roles, rejects stale confirmation, and preserves edits on repeat pulls", async () => {
		const f = await fixture();
		const personal = await f.call("contributor", "/api/team/pages/personal?namespace=default");
		const note = personal.notes[0];
		const input = { sources: [{ kind: "note", id: note.id }], personalNamespace: "default" };
		const proposal = await f.mutate("contributor", "/api/team/pages", input);
		const id = proposal.entries[0].snapshot.key;
		const first = await f.call("reviewer", `/api/team/content/pages/${id}?pending=true`);
		expect(first.content.snapshot.markdown).toContain("审核者应该能看到");
		const decision = {
			resource: "pages",
			ids: [id],
			decision: "team-approved",
			expectedVersions: { [id]: first.version },
		};
		const stale = await f.call("reviewer", "/api/team/reviews/prepare", decision);
		const staleGrant = await f.grant("reviewer", stale);
		await f.call(
			"contributor",
			`/api/research/notes/${note.id}`,
			{
				title: note.title,
				markdown: "# New version\n\nOnly this approved evidence is reusable.",
				expectedRevision: note.revision,
				expectedContentHash: note.contentHash,
				namespace: "default",
			},
			"PATCH",
		);
		await f.mutate("contributor", "/api/team/pages", input);
		expect(
			(await f.request("reviewer", "/api/team/reviews/execute", { ...decision, grant: staleGrant })).status,
		).toBe(409);
		expect((await f.call("reader", "/api/team/content?resource=pages")).entries).toEqual([]);
		const current = await f.call("reviewer", `/api/team/content/pages/${id}?pending=true`);
		await f.mutate("reviewer", "/api/team/reviews", { ...decision, expectedVersions: { [id]: current.version } });
		const search = await f.call("reader", "/api/team/content?resource=pages&q=reusable");
		expect(search.entries).toHaveLength(1);
		expect(search.entries[0].page).not.toHaveProperty("markdown");
		expect((await f.call("reader", `/api/team/content/pages/${id}`)).content.snapshot.markdown).toContain(
			"approved evidence",
		);
		const pull = { entries: [{ resource: "pages", id }], personalNamespace: "default" };
		const firstPull = await f.mutate("reader", "/api/team/knowledge-pull", pull);
		expect(firstPull.created).toHaveLength(1);
		expect((await f.mutate("reader", "/api/team/knowledge-pull", pull)).unchanged).toHaveLength(1);
		const local = (await f.call("reader", `/api/research/notes/${firstPull.created[0]}`)).note;
		await f.call(
			"reader",
			`/api/research/notes/${local.id}`,
			{
				title: local.title,
				markdown: "My private continuation",
				expectedRevision: local.revision,
				expectedContentHash: local.contentHash,
				namespace: "default",
			},
			"PATCH",
		);
		expect((await f.mutate("reader", "/api/team/knowledge-pull", pull)).preserved).toHaveLength(1);
		expect((await f.call("reader", `/api/research/notes/${local.id}`)).note.markdown).toBe("My private continuation");
		expect((await f.request("reader", "/api/team/contributions?mine=true")).status).toBe(403);
		const notices = await f.call("contributor", "/api/team/notifications");
		expect(notices.unread).toBeGreaterThan(0);
		await f.mutate("contributor", "/api/team/notifications/read", {
			ids: notices.entries.map((entry: { id: string }) => entry.id),
		});
		expect((await f.call("contributor", "/api/team/notifications")).unread).toBe(0);
	}, 60_000);
});
