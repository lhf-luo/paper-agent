import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamKnowledgeService } from "../team-server/src/application/team-knowledge-service.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("team audit log paging", () => {
	it("pages newest-first across chunk boundaries without loading the whole log", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-team-audit-"));
		temporaryPaths.push(root);
		const store = createTeamKnowledgeService(join(root, "lab"), "lab");
		const actor = { id: "u-auditor000000", name: "审计员" };
		// Multi-byte padding makes every line ~700 bytes, so 800 events span many 64 KiB read chunks and split
		// UTF-8 sequences across chunk boundaries.
		const padding = "审计填充".repeat(60);
		const total = 800;
		for (let index = 0; index < total; index++) {
			await store.appendAudit(actor, "test.event", `target-${index}`, { index, padding });
		}
		// A corrupt line in the middle must be skipped, not break paging.
		await appendFile(join(root, "lab", "events", "audit.jsonl"), "{not json}\n", "utf8");
		for (let index = total; index < total + 5; index++) {
			await store.appendAudit(actor, "test.event", `target-${index}`, { index, padding });
		}

		const seen: number[] = [];
		let cursor: string | undefined;
		do {
			const page = await store.listAuditEvents(cursor ? Number(cursor) : 0, 100);
			for (const event of page.events) seen.push((event.details as { index: number }).index);
			cursor = page.nextCursor;
		} while (cursor);
		expect(seen).toHaveLength(total + 5);
		expect(seen[0]).toBe(total + 4);
		expect(seen.at(-1)).toBe(0);
		expect(new Set(seen).size).toBe(total + 5);
		expect(seen.every((value, index) => index === 0 || seen[index - 1] === value + 1)).toBe(true);

		const first = await store.listAuditEvents(0, 1);
		expect(first.events[0]).toMatchObject({ actor: "审计员", target: `target-${total + 4}` });
		expect(first.nextCursor).toBe("1");
		const last = await store.listAuditEvents(total + 4, 10);
		expect(last.events.map((event) => event.target)).toEqual(["target-0"]);
		expect(last.nextCursor).toBeUndefined();
	}, 60_000);
});
