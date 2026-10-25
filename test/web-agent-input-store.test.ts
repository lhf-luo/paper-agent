import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyWebAgentInputs, type StoredWebAgentInput } from "../src/agent/domain/web-agent-inputs.ts";
import { WebAgentInputStore } from "../src/agent/infrastructure/web-agent-input-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-input-journal-"));
	roots.push(root);
	return { root, store: new WebAgentInputStore(root) };
}
function input(phase: StoredWebAgentInput["phase"]): StoredWebAgentInput {
	return {
		id: randomUUID(),
		content: "原始文字",
		prompt: "原始文字",
		nativeText: "展开后的文字",
		delivery: "steer",
		createdAt: "2026-10-19T00:00:00.000Z",
		status: "queued",
		phase,
	};
}

describe("durable web input journal", () => {
	it("coalesces concurrent updates and persists the latest captured snapshot before resolving", async () => {
		const { store } = await fixture();
		const state = emptyWebAgentInputs();
		const writes: Promise<void>[] = [];
		for (let index = 0; index < 50; index++) {
			state.receipts[String(index)] = String(index);
			writes.push(store.write("burst", state));
		}
		expect(new Set(writes).size).toBe(1);
		await Promise.all(writes);
		state.receipts.unpersisted = "not submitted";
		expect(Object.keys((await store.restore("burst")).receipts)).toHaveLength(50);
		await store.flush("burst");
	});

	it("rejects failed durable writes and permits retry after the filesystem is repaired", async () => {
		const { store, root } = await fixture();
		await mkdir(join(root, ".paper-agent"));
		const blocked = join(root, ".paper-agent", "web-agent-memory");
		await writeFile(blocked, "not a directory");
		const state = emptyWebAgentInputs();
		state.receipts.saved = "fingerprint";
		await expect(store.write("retry", state)).rejects.toThrow();
		await rm(blocked);
		await store.write("retry", state);
		expect((await store.restore("retry")).receipts).toEqual(state.receipts);
	});
	it("keeps old sessions compatible and pauses safely unconsumed queued inputs", async () => {
		const { store } = await fixture();
		expect(await store.restore("old-session")).toEqual(emptyWebAgentInputs());
		const state = { pending: [input("queued"), input("prepared")], paused: false, receipts: {} };
		await store.write("session", state);
		const restored = await store.restore("session");
		expect(restored.paused).toBe(true);
		expect(restored.pending.every((p) => p.status === "paused")).toBe(true);
	});

	it("flags uncertain dispatches and native user messages without a matching acknowledgement", async () => {
		const { store, root } = await fixture(),
			pending = input("queued");
		const path = join(root, "native.jsonl");
		await writeFile(
			path,
			JSON.stringify({
				type: "message",
				id: "native-user",
				message: {
					role: "user",
					timestamp: Date.parse(pending.createdAt) + 1,
					content: [{ type: "text", text: pending.nativeText }],
				},
			}),
		);
		await store.write("session", {
			pending: [pending, input("dispatching"), input("delivering")],
			paused: false,
			receipts: {},
		});
		const state = await store.restore("session", path);
		expect(state.pending.every((p) => p.status === "uncertain")).toBe(true);
	});

	it("recovers delivery by native entry IDs rather than comparing raw or repeated text", async () => {
		const { store, root } = await fixture(),
			delivered = input("queued"),
			waiting = input("queued");
		const path = join(root, "native.jsonl");
		await writeFile(
			path,
			[
				{
					type: "message",
					id: "native-user",
					message: {
						role: "user",
						timestamp: Date.parse(delivered.createdAt) + 1,
						content: [{ type: "text", text: delivered.nativeText }],
					},
				},
				{
					type: "custom",
					customType: "paper-agent-web-input",
					data: { id: delivered.id, messageEntryId: "native-user" },
				},
			]
				.map((e) => JSON.stringify(e))
				.join("\n"),
		);
		await store.write("session", {
			pending: [delivered, waiting],
			paused: false,
			receipts: { [delivered.id]: "hash" },
		});
		const state = await store.restore("session", path);
		expect(state.recovered?.map((p) => p.id)).toEqual([delivered.id]);
		expect(state.pending.map((p) => p.id)).toEqual([waiting.id]);
		// Identical text without a receipt is deliberately not replayed automatically.
		expect(state.pending[0].status).toBe("uncertain");
	});
});
