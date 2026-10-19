import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect } from "vitest";
import { WebAgentService, type WebAgentServiceOptions } from "../src/agent/application/web-agent-service.ts";

export async function queueFixture(extra?: ExtensionFactory) {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-queue-"));
	const requests: Array<{ body: any; response: ServerResponse }> = [];
	const server = createServer(async (req, response) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), response });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	await mkdir(join(root, ".agents", "skills", "queue-skill"), { recursive: true });
	await writeFile(
		join(root, ".agents", "skills", "queue-skill", "SKILL.md"),
		"---\nname: queue-skill\ndescription: Queue expansion test\n---\nSKILL_EXPANSION_MARKER",
	);
	let releaseTool!: () => void;
	const toolGate = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	let toolFinished = false;
	const extension: ExtensionFactory = async (pi) => {
		pi.on("input", (event) =>
			event.text === "rewrite"
				? { action: "transform", text: "REWRITTEN_INPUT" }
				: event.text === "handled"
					? { action: "handled" }
					: undefined,
		);
		pi.registerTool({
			name: "queue_gate",
			label: "Queue gate",
			description: "Controlled tool",
			parameters: Type.Object({ confirm: Type.Optional(Type.Boolean()) }),
			async execute(_id, input, _signal, _update, ctx) {
				const approved = !input.confirm || (await ctx.ui.confirm("工具确认", "允许这次工具执行？"));
				await toolGate;
				toolFinished = true;
				return { content: [{ type: "text", text: approved ? "approved" : "rejected" }], details: { approved } };
			},
		});
		await extra?.(pi);
	};
	let options: Partial<WebAgentServiceOptions> = {};
	const configure = async () => {
		const service = await WebAgentService.create({ projectRoot: root, extensionFactory: extension, ...options });
		await service.updateConfig({
			providerId: "queue-fixture",
			modelId: "queue-model",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
			apiKey: "synthetic-queue-key",
		});
		return service;
	};
	let service = await configure();
	function delta(index: number, choices: any[], usage?: number) {
		const response = requests[index].response;
		if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(
			`data: ${JSON.stringify({
				id: `queue-${index}`,
				object: "chat.completion.chunk",
				model: "queue-model",
				choices,
				...(usage ? { usage: { prompt_tokens: usage, completion_tokens: 1, total_tokens: usage + 1 } } : {}),
			})}\n\n`,
		);
	}
	return {
		root,
		requests,
		get service() {
			return service;
		},
		get toolFinished() {
			return toolFinished;
		},
		releaseTool,
		async waitRequest(index: number) {
			await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThan(index);
		},
		stream(index: number, content = "正在处理") {
			delta(index, [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]);
		},
		release(index: number, content = "已完成", tool?: { confirm?: boolean }, usage?: number) {
			delta(index, [
				{
					index: 0,
					delta: tool
						? {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: `gate-${index}`,
										type: "function",
										function: { name: "queue_gate", arguments: JSON.stringify(tool) },
									},
								],
							}
						: { role: "assistant", content },
					finish_reason: null,
				},
			]);
			delta(index, [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage);
			requests[index].response.end("data: [DONE]\n\n");
		},
		fail(index: number, status = 401) {
			requests[index].response.writeHead(status, { "content-type": "application/json" });
			requests[index].response.end(
				JSON.stringify({
					error: { message: status === 401 ? "invalid test credential" : "server overloaded, retry later" },
				}),
			);
		},
		async restart(nextOptions: Partial<WebAgentServiceOptions> = {}, afterClose?: () => Promise<void>) {
			await service.close();
			await afterClose?.();
			options = { ...options, ...nextOptions };
			service = await configure();
		},
		async close() {
			releaseTool();
			await service.close();
			for (const r of requests) r.response.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		},
	};
}

export function lastUser(request: { body: any }): string {
	const value = request.body.messages.filter((m: any) => m.role === "user").at(-1)?.content;
	return typeof value === "string"
		? value
		: (value ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");
}
