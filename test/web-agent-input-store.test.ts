import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
