import { afterEach, describe, expect, it, vi } from "vitest";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { PaperAgentSessionRepository } from "../src/agent/infrastructure/paper-agent-session-repository.ts";
import { queueFixture } from "./web-agent-queue-fixture.ts";

const fixtures: Awaited<ReturnType<typeof queueFixture>>[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
	vi.restoreAllMocks();
});

describe("Web Agent submission latency", () => {
	it("acknowledges durable input before a slow before_agent_start handler completes", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const f = await queueFixture((pi) => { pi.on("before_agent_start", () => gate); });
		fixtures.push(f);
		try {
			const s = f.service.createSession({ mode: "persistent" });
			const result = await f.service.sendMessage(s.id, { message: "开始" });
			expect(result.status).toBe("running");
			expect(f.requests).toHaveLength(0);
			expect(result.pendingInputs.map((input) => input.content)).toEqual(["开始"]);
			await f.service.sendMessage(s.id, { message: "启动期间追加", delivery: "followUp" });
			expect(f.service.getSession(s.id).pendingInputs).toHaveLength(2);
			release();
			await f.waitRequest(0);
			f.release(0);
			await f.waitRequest(1);
			f.release(1);
			await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
			expect(f.service.getSession(s.id).messages.filter((message) => message.role === "user")
				.map((message) => message.content)).toEqual(["开始", "启动期间追加"]);
		} finally { release(); }
	});

	it("allows queueing during input preprocessing and honours a stop requested before native startup", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const f = await queueFixture((pi) => {
			pi.on("input", async (event) => { if (event.text === "慢速输入") await gate; });
		});
		fixtures.push(f);
		try {
			const s = f.service.createSession({ mode: "persistent" });
			await f.service.sendMessage(s.id, { message: "慢速输入" });
			await f.service.sendMessage(s.id, { message: "等待继续", delivery: "followUp" });
			const stopped = f.service.abortSession(s.id);
			await expect.poll(() => f.service.getSession(s.id).status).toBe("stopping");
			release();
			await stopped;
			expect(f.service.getSession(s.id).status).toBe("idle");
			expect(f.service.getSession(s.id).queuePaused).toBe(true);
			expect(f.service.getSession(s.id).pendingInputs.some((input) => input.content === "等待继续")).toBe(true);
			expect(f.requests).toHaveLength(0);
		} finally { release(); }
	});

	it("does not rewrite a paper transcript when only its pending queue changes", async () => {
		const f = await queueFixture();
		fixtures.push(f);
		const library = new LiteratureStore(resolveCorpusRoot(f.root, "personal"), "personal");
		await library.upsertPaper({
			id: "latency-paper", title: "Latency", authors: [], identifiers: {}, links: [], provenance: [], mergedFrom: [],
		});
		await f.restart({ paperSessionDatabasePath: library.databasePath });
		const saves = vi.spyOn(PaperAgentSessionRepository.prototype, "save");
		const s = f.service.createSession({ mode: "persistent", context: { kind: "paper", paperId: "latency-paper" } });
		await f.service.sendMessage(s.id, { message: "开始" });
		await f.waitRequest(0);
		const before = saves.mock.calls.length;
		await f.service.sendMessage(s.id, { message: "追加一", delivery: "followUp" });
		await f.service.sendMessage(s.id, { message: "追加二", delivery: "followUp" });
		expect(saves).toHaveBeenCalledTimes(before);
		f.release(0);
		for (const index of [1, 2]) { await f.waitRequest(index); f.release(index); }
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
	});
});
