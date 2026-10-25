import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SearchRunGraphs } from "../src/canvas/application/search-run-graphs.ts";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebAgentService } from "../src/agent/application/web-agent-service.ts";
import { CanvasResearchService } from "../src/canvas/application/canvas-research-service.ts";
import { createCanvasResearchRuntime } from "../src/canvas/presentation/canvas-research-tools.ts";
import { abstractCard, researchFixture } from "./canvas-research-fixture.ts";

function completion(response: ServerResponse, step: number, name?: string, args?: unknown) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta: unknown, reason: string | null) =>
		response.write(
			`data: ${JSON.stringify({ id: `completion-${step}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fake-model", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
		);
	if (name) {
		chunk(
			{
				role: "assistant",
				tool_calls: [
					{ index: 0, id: `tool-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
				],
			},
			null,
		);
		chunk({}, "tool_calls");
	} else {
		chunk({ role: "assistant", content: "Partial research and reviewed layout saved." }, null);
		chunk({}, "stop");
	}
	response.end("data: [DONE]\n\n");
}
async function localResearchModel(mode: "research" | "editing" | "search" = "research") {
	const requests: Array<{
		messages: Array<{ role: string; content: string }>;
		tools: Array<{ function: { name: string } }>;
	}> = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body);
		const step = requests.length;
		const last = [...body.messages].reverse().find((m: { role: string }) => m.role === "tool");
		const result = last ? JSON.parse(last.content) : undefined;
		if (mode === "search") {
			if (step === 1) completion(response, step, "show_search_run_graph", { search_run_id: "sdk-search" });
			else completion(response, step);
			return;
		}
		if (mode === "editing") {
			if (step === 1) completion(response, step, "get_canvas_overview", {});
			else if (step === 2)
				completion(response, step, "propose_canvas_nodes", {
					request_id: "authors",
					expected_revision: result.revision,
					reason: "Add author",
					nodes: [{ key: "author", kind: "author", title: "Author 0" }],
					edges: [{ from: { new_node: "author" }, to: { node_id: "node-p0" }, label: "作者" }],
				});
			else if (step === 3) completion(response, step, "apply_canvas_changes", { proposal_id: result.proposalId });
			else completion(response, step);
			return;
		}
		if (step === 1) completion(response, step, "get_canvas_nodes", {});
		else if (step === 2)
			completion(response, step, "save_canvas_analysis", {
				content: {
					cards: ["p0", "p1", "p2"].map(abstractCard),
					summary: "Three abstract-screened papers; body verification pending",
					status: "partial",
				},
			});
		else if (step === 3)
			completion(response, step, "preview_canvas_changes", {
				analysis_id: result.id,
				reason: "Classify methods",
				layout: "methods",
			});
		else if (step === 4) completion(response, step, "apply_canvas_changes", { proposal_id: result.id });
		else completion(response, step);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		requests,
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
async function until(check: () => boolean) {
	const end = Date.now() + 10000;
	while (!check()) {
		if (Date.now() > end) throw new Error("Canvas session did not reach expected state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
describe("canvas research through the real Agent SDK", () => {
	it.each(["ask", "auto"] as const)(
		"injects editing tools only into canvas sessions and waits for preview in %s mode",
		async (permissionMode) => {
			const f = await researchFixture(),
				provider = await localResearchModel("editing");
			const agent = await WebAgentService.create({
				projectRoot: f.root,
				paperSessionDatabasePath: f.library.databasePath,
				canvasDatabasePath: () => f.library.databasePath,
				canvasResearchFactory: (ctx, id) =>
					createCanvasResearchRuntime(new CanvasResearchService(f.library, ctx.canvasId, id)),
			});
			try {
				await agent.updateConfig({
					providerId: "fixture",
					modelId: "fake-model",
					baseUrl: provider.baseUrl,
					api: "openai-completions",
					apiKey: "local-fixture-only",
				});
				const session = agent.createSession({
					mode: "persistent",
					permissionMode,
					context: { kind: "canvas", canvasId: f.service.canvasId },
				});
				const board = f.service.board();
				f.service.canvases.update(board.id, board.revision, {
					...board,
					nodes: board.nodes.map((node) => (node.id === "agent-a" ? { ...node, entityId: session.id } : node)),
				});
				const revision = f.service.board().revision;
				await agent.sendMessage(session.id, { message: "为这篇论文创建作者节点" });
				await until(() =>
					agent
						.getSession(session.id)
						.tools.some((tool) => tool.name === "apply_canvas_changes" && tool.status === "running"),
				);
				expect(f.service.board().revision).toBe(revision);
				expect(f.service.records.list("analysis")).toEqual([]);
				const proposal =
					f.service.records.list<import("../src/canvas/domain/canvas-research.ts").CanvasChangeProposal>(
						"proposal",
					)[0];
				expect(proposal.value).toMatchObject({ purpose: "editing", status: "pending" });
				await f.service.apply(
					proposal.id,
					proposal.value.operations.map((op) => op.id),
					revision,
				);
				await until(() => agent.getSession(session.id).status !== "running");
				expect(agent.getSession(session.id).error).toBeUndefined();
				expect(f.service.board().nodes.some((node) => node.kind === "author")).toBe(true);
				for (const context of [undefined, { kind: "paper" as const, paperId: "p0" }]) {
					const plain = agent.createSession({ mode: "once", context });
					await agent.sendMessage(plain.id, { message: "ordinary chat" });
					await until(() => agent.getSession(plain.id).status !== "running");
					expect(
						Boolean(
							provider.requests.at(-1)?.tools?.some((tool) => tool.function.name === "propose_canvas_nodes"),
						),
					).toBe(false);
				}
			} finally {
				await agent.close();
				await provider.close();
			}
		},
	);

	it.each(["ask", "auto"] as const)(
		"shows a search graph without a proposal and scopes tools/skills in %s mode",
		async (permissionMode) => {
			const f = await researchFixture(),
				provider = await localResearchModel("search");
			await f.library.saveSearchRun({
				id: "sdk-search",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				queries: ["SDK candidate"],
				filters: {},
				providers: [],
				results: [
					{
						id: "sdk-candidate",
						title: "SDK search candidate",
						authors: ["Author"],
						identifiers: { arxivId: "2601.11111" },
						links: [],
						provenance: [],
						mergedFrom: [],
					},
				],
				failures: [],
				sourceCounts: {},
				deduplicatedCount: 1,
				pagesPerProvider: 1,
				maxResultsPerProvider: 1,
				scope: "personal",
				mode: "once",
			});
			for (const name of ["canvas-research", "literature-corpus-manager"]) {
				const dir = join(f.root, ".agents", "skills", name);
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, "SKILL.md"),
					`---\nname: ${name}\ndescription: Fixture workflow ${name}\n---\nFixture only`,
				);
			}
			const config = defaultPaperAgentConfig();
			config.agent.builtinTools = ["read"];
			await savePaperAgentConfig(f.root, config);
			const agent = await WebAgentService.create({
				projectRoot: f.root,
				paperSessionDatabasePath: f.library.databasePath,
				canvasDatabasePath: () => f.library.databasePath,
				canvasResearchFactory: (ctx, id) =>
					createCanvasResearchRuntime(new CanvasResearchService(f.library, ctx.canvasId, id)),
			});
			try {
				await agent.updateConfig({
					providerId: "fixture",
					modelId: "fake-model",
					baseUrl: provider.baseUrl,
					api: "openai-completions",
					apiKey: "local-fixture-only",
				});
				const session = agent.createSession({
					mode: "persistent",
					permissionMode,
					context: { kind: "canvas", canvasId: f.service.canvasId },
				});
				const board = f.service.board();
				f.service.canvases.update(board.id, board.revision, {
					...board,
					nodes: board.nodes.map((node) => (node.id === "agent-a" ? { ...node, entityId: session.id } : node)),
				});
				const revision = f.service.board().revision;
				expect(agent.listSkills(session.id).map((s) => s.name)).toContain("canvas-research");
				expect(agent.listSkills(session.id).map((s) => s.name)).not.toContain("literature-corpus-manager");
				await expect(
					agent.sendMessage(session.id, { message: "/skill:literature-corpus-manager search" }),
				).rejects.toThrow("canvas-research");
				await agent.sendMessage(session.id, { message: "用图谱展示 sdk-search" });
				await until(() => agent.getSession(session.id).status !== "running");
				expect(agent.getSession(session.id).error).toBeUndefined();
				expect(f.service.board().revision).toBe(revision);
				expect(f.service.records.list("analysis")).toEqual([]);
				expect(f.service.records.list("proposal")).toEqual([]);
				expect(new SearchRunGraphs(f.library, board.id).views.get("sdk-search")).toBeDefined();
				const system = provider.requests[0].messages
					.filter((m) => m.role === "system")
					.map((m) => m.content)
					.join("\n");
				expect(system).not.toContain("<name>literature-corpus-manager</name>");
				expect(system).toContain("<name>canvas-research</name>");
				for (const context of [undefined, { kind: "paper" as const, paperId: "p0" }]) {
					const plain = agent.createSession({ mode: "once", context });
					expect(agent.listSkills(plain.id).map((s) => s.name)).toContain("literature-corpus-manager");
					await agent.sendMessage(plain.id, { message: "ordinary chat" });
					await until(() => agent.getSession(plain.id).status !== "running");
					expect(
						Boolean(
							provider.requests.at(-1)?.tools?.some((tool) => tool.function.name === "show_search_run_graph"),
						),
					).toBe(false);
				}
			} finally {
				await agent.close();
				await provider.close();
			}
		},
	);

	it("binds context, executes research tools and waits for a human even in auto permission mode", async () => {
		const f = await researchFixture(),
			provider = await localResearchModel();
		const agent = await WebAgentService.create({
			projectRoot: f.root,
			paperSessionDatabasePath: f.library.databasePath,
			canvasDatabasePath: () => f.library.databasePath,
			canvasResearchFactory: (ctx, id) =>
				createCanvasResearchRuntime(new CanvasResearchService(f.library, ctx.canvasId, id)),
		});
		try {
			await agent.updateConfig({
				providerId: "fixture",
				modelId: "fake-model",
				baseUrl: provider.baseUrl,
				api: "openai-completions",
				apiKey: "local-fixture-only",
			});
			const session = agent.createSession({
				mode: "persistent",
				permissionMode: "auto",
				context: { kind: "canvas", canvasId: f.service.canvasId },
			});
			const board = f.service.board();
			f.service.canvases.update(board.id, board.revision, {
				...board,
				nodes: board.nodes.map((n) => (n.id === "agent-a" ? { ...n, entityId: session.id } : n)),
			});
			f.service.saveSettings({ question: "Compare synthesized checkers" }, -1);
			const revision = f.service.board().revision;
			await agent.sendMessage(session.id, {
				message: "总结研究方式并整理画布",
				canvasContext: { agentNodeId: "agent-a" },
			});
			await until(() =>
				agent.getSession(session.id).tools.some((t) => t.name === "apply_canvas_changes" && t.status === "running"),
			);
			expect(f.service.board().revision).toBe(revision);
			const proposal =
				f.service.records.list<import("../src/canvas/domain/canvas-research.ts").CanvasChangeProposal>(
					"proposal",
				)[0];
			expect(proposal.value.status).toBe("pending");
			await f.service.apply(
				proposal.id,
				proposal.value.operations.map((op) => op.id),
				revision,
			);
			await until(() => agent.getSession(session.id).status !== "running");
			expect(agent.getSession(session.id).status).toBe("idle");
			expect(agent.getSession(session.id).messages.at(-1)?.content).toContain("reviewed layout saved");
			expect(f.service.board().groups).toHaveLength(1);
			expect(
				provider.requests[0].messages.some((m) =>
					JSON.stringify(m.content).includes("Compare synthesized checkers"),
				),
			).toBe(true);
			expect(provider.requests[0].tools.some((t) => t.function.name === "get_canvas_nodes")).toBe(true);
			expect(agent.getSession(session.id).messages[0].content).toBe("总结研究方式并整理画布");
			const generic = agent.createSession({ mode: "persistent" });
			await agent.sendMessage(generic.id, { message: "ordinary chat" });
			await until(() => agent.getSession(generic.id).status !== "running");
			expect(Boolean(provider.requests.at(-1)?.tools?.some((t) => t.function.name === "get_canvas_nodes"))).toBe(
				false,
			);
		} finally {
			await agent.close();
			await provider.close();
		}
	});
});
