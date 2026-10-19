import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchCanvasStore } from "../src/canvas/infrastructure/research-canvas-store.ts";
import { LiteratureStore, resolveCorpusRoot } from "../src/literature/application/literature-store.ts";
import { lastUser, queueFixture } from "./web-agent-queue-fixture.ts";

const fixtures: Awaited<ReturnType<typeof queueFixture>>[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((f) => f.close()));
});
async function fixture() {
	const f = await queueFixture();
	fixtures.push(f);
	return f;
}

describe("Pi native web input queues", () => {
	it("accepts both kinds of input while Pi performs automatic context compaction", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "生成分析" });
		await f.waitRequest(0);
		f.release(0, "已有分析内容。".repeat(15000), undefined, 125000);
		await f.waitRequest(1);
		expect(JSON.stringify(f.requests[1].body.messages)).toContain("summary");
		await f.service.sendMessage(s.id, { message: "压缩期间插话" });
		await f.service.sendMessage(s.id, { message: "压缩期间追加", delivery: "followUp" });
		expect(f.service.getSession(s.id).pendingInputs).toHaveLength(2);
		f.release(1, "保留目标与已完成分析的摘要");
		await f.waitRequest(2);
		expect(lastUser(f.requests[2])).toBe("压缩期间插话");
		f.release(2);
		await f.waitRequest(3);
		expect(lastUser(f.requests[3])).toBe("压缩期间追加");
		f.release(3);
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
	}, 20000);
	it("restores acknowledged delivery after a crash without replaying the accepted request", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "开始" });
		await f.waitRequest(0);
		const id = randomUUID(),
			request = { message: "已经送达", clientMessageId: id };
		await f.service.sendMessage(s.id, request);
		const queuePath = join(f.root, ".paper-agent", "web-agent-memory", "input-queues", `${s.id}.json`);
		const before = await readFile(queuePath, "utf8");
		f.release(0);
		await f.waitRequest(1);
		f.release(1);
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
		await f.restart({}, async () => {
			await writeFile(queuePath, before);
			const path = join(f.root, ".paper-agent", "web-agent-memory", "session-views", `${s.id}.json`);
			const view = JSON.parse(await readFile(path, "utf8"));
			view.messages = view.messages.filter((m: any) => m.id !== id);
			await writeFile(path, JSON.stringify(view));
		});
		expect(f.service.getSession(s.id).pendingInputs).toEqual([]);
		expect(f.service.getSession(s.id).messages.filter((m) => m.id === id)).toHaveLength(1);
		await f.service.sendMessage(s.id, request);
		expect(f.requests).toHaveLength(2);
	});

	it("keeps paper queues in their namespace and does not restart canvas research when queueing", async () => {
		const f = await fixture();
		const library = new LiteratureStore(resolveCorpusRoot(f.root, "personal", "default"), "personal", "default");
		await library.upsertPaper({
			id: "queue-paper",
			title: "队列论文",
			authors: [],
			identifiers: {},
			links: [],
			provenance: [],
			mergedFrom: [],
		});
		const canvases = new ResearchCanvasStore(library.databasePath, "default"),
			board = canvases.create("队列画布");
		const rounds: boolean[] = [];
		await f.restart({
			paperSessionDatabasePath: library.databasePath,
			canvasResearchFactory: () => ({
				extension: () => undefined,
				prepare: async (_input, options) => {
					rounds.push(!options?.continueRound);
					return "固定的画布范围";
				},
				finish: () => undefined,
			}),
		});
		const paper = f.service.createSession({
			mode: "persistent",
			context: { kind: "paper", namespace: "default", paperId: "queue-paper" },
		});
		await f.service.sendMessage(paper.id, { message: "当前论文" });
		await f.waitRequest(0);
		await f.service.sendMessage(paper.id, { message: "后续论文问题", delivery: "followUp" });
		await f.restart();
		expect(f.service.listSessions({ scope: "paper", namespace: "other", paperId: "queue-paper" })).toEqual([]);
		expect(f.service.getSession(paper.id).pendingInputs).toHaveLength(1);
		await f.service.resumeQueue(paper.id);
		await f.waitRequest(1);
		expect(lastUser(f.requests[1])).toContain('paper_id: "queue-paper"');
		f.release(1);
		await expect.poll(() => f.service.getSession(paper.id).status).toBe("idle");
		const canvas = f.service.createSession({
			mode: "persistent",
			context: { kind: "canvas", namespace: "default", canvasId: board.id },
		});
		await f.service.sendMessage(canvas.id, { message: "总结画布" });
		await f.waitRequest(2);
		await f.service.sendMessage(canvas.id, { message: "只读摘要" });
		await f.service.sendMessage(canvas.id, { message: "然后分类", delivery: "followUp" });
		expect(rounds).toEqual([true, false, false]);
		for (let i = 2; i < 5; i++) {
			f.release(i);
			if (i < 4) await f.waitRequest(i + 1);
		}
		await expect.poll(() => f.service.getSession(canvas.id).status).toBe("idle");
		expect(lastUser(f.requests[4])).toContain("固定的画布范围");
	});
	it("prioritizes steer, drains one message at a time and only displays delivered inputs", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "开始" });
		await f.waitRequest(0);
		for (const [message, delivery] of [
			["后续一", "followUp"],
			["后续二", "followUp"],
			["插话一", "steer"],
			["插话二", "steer"],
		] as const)
			await f.service.sendMessage(s.id, { message, delivery });
		expect(f.service.getSession(s.id).pendingInputs).toHaveLength(4);
		expect(
			f.service
				.getSession(s.id)
				.messages.filter((m) => m.role === "user")
				.map((m) => m.content),
		).toEqual(["开始"]);
		for (const [index, text] of ["插话一", "插话二", "后续一", "后续二"].entries()) {
			f.release(index);
			await f.waitRequest(index + 1);
			expect(lastUser(f.requests[index + 1])).toBe(text);
		}
		f.release(4);
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
		expect(f.service.getSession(s.id).pendingInputs).toEqual([]);
		expect(
			f.service
				.getSession(s.id)
				.messages.filter((m) => m.role === "user")
				.map((m) => m.content),
		).toEqual(["开始", "插话一", "插话二", "后续一", "后续二"]);
	});

	it("deduplicates retries and correlates duplicate text, input transforms, skills and handled input", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "开始" });
		await f.waitRequest(0);
		const id = randomUUID();
		await f.service.sendMessage(s.id, { message: "重复", clientMessageId: id });
		await f.service.sendMessage(s.id, { message: "重复", clientMessageId: id });
		await expect(f.service.sendMessage(s.id, { message: "其他", clientMessageId: id })).rejects.toThrow("消息标识");
		await f.service.sendMessage(s.id, { message: "重复", delivery: "followUp" });
		await f.service.sendMessage(s.id, { message: "rewrite" });
		await f.service.sendMessage(s.id, { message: "/skill:queue-skill 后续" });
		await f.service.sendMessage(s.id, { message: "handled" });
		expect(f.service.getSession(s.id).pendingInputs).toHaveLength(4);
		for (let i = 0; i < 5; i++) {
			f.release(i);
			if (i < 4) await f.waitRequest(i + 1);
		}
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
		expect(lastUser(f.requests[2])).toBe("REWRITTEN_INPUT");
		expect(lastUser(f.requests[3])).toContain("SKILL_EXPANSION_MARKER");
		expect(
			f.service
				.getSession(s.id)
				.messages.filter((m) => m.role === "user")
				.map((m) => m.content),
		).toEqual(["开始", "重复", "rewrite", "/skill:queue-skill 后续", "重复"]);
	});

	it.each(["persistent", "once"] as const)(
		"pauses on stop and manually resumes the original %s context",
		async (mode) => {
			const f = await fixture(),
				s = f.service.createSession({ mode });
			await f.service.sendMessage(s.id, { message: "原始上下文" });
			await f.waitRequest(0);
			f.stream(0);
			await f.service.sendMessage(s.id, { message: "第一条" });
			await f.service.sendMessage(s.id, { message: "第二条", delivery: "followUp" });
			const stopped = await f.service.abortSession(s.id);
			expect(stopped.queuePaused).toBe(true);
			expect(stopped.pendingInputs.every((p) => p.status === "paused")).toBe(true);
			await f.service.sendMessage(s.id, { message: "第三条", delivery: "followUp" });
			expect(f.requests).toHaveLength(1);
			await f.service.resumeQueue(s.id);
			await f.waitRequest(1);
			expect(JSON.stringify(f.requests[1].body.messages)).toContain("原始上下文");
			for (let i = 1; i < 4; i++) {
				f.release(i);
				if (i < 3) await f.waitRequest(i + 1);
			}
			await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
			expect(f.service.getSession(s.id).pendingInputs).toEqual([]);
			expect(f.requests.map(lastUser)).toEqual(["原始上下文", "第一条", "第二条", "第三条"]);
		},
	);

	it("restores paused inputs after restart, preserves attachment snapshots and supports clearing", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "开始" });
		await f.waitRequest(0);
		const attachment = await f.service.uploadAttachment(s.id, { name: "材料.md", data: Buffer.from("固定快照") });
		await f.service.sendMessage(s.id, { message: "阅读附件", delivery: "followUp", attachments: [attachment] });
		await f.restart();
		expect(f.requests).toHaveLength(1);
		expect(f.service.getSession(s.id)).toMatchObject({
			queuePaused: true,
			pendingInputs: [{ status: "paused", attachmentNames: ["材料.md"] }],
		});
		await f.service.resumeQueue(s.id);
		await f.waitRequest(1);
		expect(lastUser(f.requests[1])).toContain(attachment.path);
		expect(await readFile(attachment.path, "utf8")).toBe("固定快照");
		await f.service.sendMessage(s.id, { message: "应当清空" });
		await f.service.clearQueue(s.id);
		f.release(1);
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
		expect(f.requests).toHaveLength(2);
		expect(f.service.getSession(s.id).pendingInputs).toEqual([]);
		await f.service.deleteSession(s.id);
		await expect(
			readFile(join(f.root, ".paper-agent", "web-agent-memory", "input-queues", `${s.id}.json`)),
		).rejects.toThrow();
	});

	it("pauses remaining messages after a terminal provider failure", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "失败的任务" });
		await f.waitRequest(0);
		await f.service.sendMessage(s.id, { message: "尚未执行" });
		f.fail(0);
		await expect.poll(() => f.service.getSession(s.id).status).toBe("error");
		expect(f.service.getSession(s.id)).toMatchObject({
			queuePaused: true,
			pendingInputs: [{ status: "paused", content: "尚未执行" }],
		});
		expect(f.requests).toHaveLength(1);
	});

	it("waits for the tool and its existing confirmation before delivering a steer", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "工具任务" });
		await f.waitRequest(0);
		f.release(0, "", { confirm: true });
		await expect.poll(() => f.service.getSession(s.id).uiRequests.length).toBe(1);
		await f.service.sendMessage(s.id, { message: "改变方向" });
		expect(f.requests).toHaveLength(1);
		expect(f.toolFinished).toBe(false);
		const request = f.service.getSession(s.id).uiRequests[0];
		await f.service.respondToUI(s.id, request.id, false);
		f.releaseTool();
		await f.waitRequest(1);
		expect(f.toolFinished).toBe(true);
		expect(lastUser(f.requests[1])).toBe("改变方向");
		expect(JSON.stringify(f.requests[1].body.messages)).toContain("rejected");
		f.release(1);
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
		expect(f.service.getSession(s.id).tools[0].assistantMessageId).toBeTruthy();
	});

	it("allows native retries to continue without duplicating queued inputs", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "重试任务" });
		await f.waitRequest(0);
		const id = randomUUID();
		await f.service.sendMessage(s.id, { message: "重试期间的补充", clientMessageId: id });
		f.fail(0, 503);
		await f.waitRequest(1);
		expect(f.service.getSession(s.id).queuePaused).toBe(false);
		f.release(1);
		await expect.poll(() => f.service.getSession(s.id).status, { timeout: 10000 }).toBe("idle");
		expect(f.service.getSession(s.id).messages.filter((m) => m.id === id)).toHaveLength(1);
		expect(f.service.getSession(s.id).pendingInputs).toEqual([]);
	}, 20000);

	it("serializes concurrent submissions and handles a submission racing with settlement", async () => {
		const f = await fixture(),
			s = f.service.createSession({ mode: "persistent" });
		await f.service.sendMessage(s.id, { message: "开始" });
		await f.waitRequest(0);
		await Promise.all(["并发一", "并发二"].map((message) => f.service.sendMessage(s.id, { message })));
		f.release(0);
		await f.waitRequest(1);
		f.release(1);
		await f.waitRequest(2);
		f.release(2);
		await f.service.sendMessage(s.id, { message: "结束边界" });
		await f.waitRequest(3);
		f.release(3);
		await expect.poll(() => f.service.getSession(s.id).status).toBe("idle");
		expect(f.requests).toHaveLength(4);
		expect(
			f.service
				.getSession(s.id)
				.messages.filter((m) => m.role === "user")
				.map((m) => m.content),
		).toEqual(["开始", "并发一", "并发二", "结束边界"]);
	});
});
