import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebAgentService } from "../src/agent/application/web-agent-service.ts";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { ResearchCanvasStore } from "../src/canvas/infrastructure/research-canvas-store.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("canvas Agent conversations", () => {
	it("removes orphaned canvas sessions during startup after interrupted board cleanup", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-canvas-orphan-"));
		roots.push(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, "data") });
		const personal = application.personalStore("default");
		await personal.initialize();
		const databasePath = personal.databasePath;
		const canvases = new ResearchCanvasStore(databasePath, "default");
		const board = canvases.create("短暂项目");
		const first = await WebAgentService.create({ projectRoot: root, paperSessionDatabasePath: databasePath });
		const session = first.createSession({
			mode: "persistent",
			context: { kind: "canvas", namespace: "default", canvasId: board.id },
		});
		await first.close();
		const restored = await WebAgentService.create({ projectRoot: root, paperSessionDatabasePath: databasePath });
		expect(restored.listSessions({ scope: "canvas", namespace: "default", canvasId: board.id })).toMatchObject([
			{ id: session.id },
		]);
		await restored.close();
		canvases.delete(board.id, board.revision);
		const second = await WebAgentService.create({ projectRoot: root, paperSessionDatabasePath: databasePath });
		try {
			expect(second.listSessions({ scope: "canvas", namespace: "default", canvasId: board.id })).toEqual([]);
			await expect(
				access(join(root, ".paper-agent", "web-agent-memory", "session-views", `${session.id}.json`)),
			).rejects.toThrow();
		} finally {
			await second.close();
			await application.close();
		}
	});

	it("scopes, restores, copies and permanently cleans conversations independently of nodes", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-canvas-agent-"));
		roots.push(root);
		await mkdir(join(root, "web"));
		await writeFile(join(root, "web", "index.html"), "<!doctype html>");
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, "data") });
		const personal = application.personalStore("default");
		await personal.initialize();
		const agentService = await WebAgentService.create({
			projectRoot: root,
			paperSessionDatabasePath: personal.databasePath,
			canvasDatabasePath: (namespace) => application.personalStore(namespace).databasePath,
		});
		const server = await startLocalWebServer(application, { staticRoot: join(root, "web"), agentService });
		const request = async (path: string, method = "GET", body?: unknown) => {
			const response = await fetch(`${server.url}${path}`, {
				method,
				...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
			});
			return { status: response.status, data: (await response.json()) as Record<string, any> };
		};
		try {
			const board = (await request("/api/canvases", "POST", { namespace: "default", title: "项目" })).data.canvas;
			const other = (await request("/api/canvases", "POST", { namespace: "default", title: "其他项目" })).data
				.canvas;
			const secondNamespaceBoard = (
				await request("/api/canvases", "POST", { namespace: "alternate", title: "另一个库" })
			).data.canvas;
			const secondNamespaceSession = await request("/api/agent/sessions", "POST", {
				mode: "persistent",
				title: "另一个助手",
				context: { kind: "canvas", namespace: "alternate", canvasId: secondNamespaceBoard.id },
			});
			expect(secondNamespaceSession.status).toBe(201);
			expect(
				(
					await request("/api/agent/sessions", "POST", {
						mode: "once",
						context: { kind: "canvas", namespace: "default", canvasId: board.id },
					})
				).status,
			).toBe(400);
			expect(
				(
					await request("/api/agent/sessions", "POST", {
						mode: "persistent",
						context: { kind: "canvas", namespace: "default", canvasId: secondNamespaceBoard.id },
					})
				).status,
			).toBe(404);
			const created = await request("/api/agent/sessions", "POST", {
				mode: "persistent",
				title: "研究助手",
				context: { kind: "canvas", namespace: "default", canvasId: board.id },
			});
			expect(created.status).toBe(201);
			const session = created.data;
			expect((await request("/api/agent/sessions")).data.sessions).toEqual([]);
			expect((await request("/api/agent/sessions?scope=personal&namespace=default")).data.sessions).toEqual([]);
			expect(
				(await request(`/api/agent/sessions?scope=canvas&namespace=default&canvasId=${other.id}`)).data.sessions,
			).toEqual([]);
			expect(
				(await request(`/api/agent/sessions?scope=canvas&namespace=alternate&canvasId=${secondNamespaceBoard.id}`))
					.data.sessions,
			).toHaveLength(1);
			expect(
				(await request(`/api/agent/sessions?scope=canvas&namespace=default&canvasId=${board.id}`)).data.sessions,
			).toHaveLength(1);
			const node = {
				id: "agent-node",
				kind: "agent",
				x: 20,
				y: 40,
				width: 260,
				height: 145,
				title: "研究助手",
				entityId: session.id,
			};
			const document = { title: board.title, nodes: [node], edges: [], viewport: board.viewport };
			expect(
				(await request(`/api/canvases/${board.id}`, "PUT", { namespace: "default", expectedRevision: 0, document }))
					.status,
			).toBe(200);
			expect(
				(await request(`/api/canvases/${other.id}`, "PUT", { namespace: "default", expectedRevision: 0, document }))
					.status,
			).toBe(400);
			const copy = await request(`/api/canvases/${board.id}/copy`, "POST", {
				namespace: "default",
				expectedRevision: 1,
			});
			expect(copy.status).toBe(201);
			const copiedSessionId = copy.data.canvas.nodes[0].entityId;
			expect(copiedSessionId).not.toBe(session.id);
			expect(agentService.getSession(copiedSessionId)).toMatchObject({
				title: "研究助手",
				messages: [],
				context: { canvasId: copy.data.canvas.id },
			});
			expect(
				(
					await request(`/api/canvases/${board.id}`, "PUT", {
						namespace: "default",
						expectedRevision: 1,
						document: { ...document, nodes: [] },
					})
				).status,
			).toBe(200);
			expect(agentService.getSession(session.id).id).toBe(session.id);
			const idea = { id: "idea-node", kind: "text", x: 320, y: 40, width: 260, height: 145, title: "想法" };
			const reattached = {
				...document,
				nodes: [node, idea],
				edges: [{ id: "agent-edge", from: node.id, to: idea.id, label: "讨论" }],
			};
			expect(
				(
					await request(`/api/canvases/${board.id}`, "PUT", {
						namespace: "default",
						expectedRevision: 2,
						document: reattached,
					})
				).status,
			).toBe(200);
			const runtime = join(root, ".paper-agent", "web-agent-memory", "pi-sessions", `runtime_${session.id}.jsonl`);
			await writeFile(runtime, "runtime state");
			const upload = join(root, ".paper-agent", "web-agent-memory", "uploads", session.id, "attachment.txt");
			await mkdir(join(root, ".paper-agent", "web-agent-memory", "uploads", session.id), { recursive: true });
			await writeFile(upload, "attachment");
			const resultFile = join(root, ".paper-agent", "web-agent-memory", "results", `${session.id}-summary.md`);
			await mkdir(join(root, ".paper-agent", "web-agent-memory", "results"), { recursive: true });
			await writeFile(resultFile, "result");
			const removed = await request(`/api/canvases/${board.id}/agent-sessions/${session.id}`, "DELETE", {
				namespace: "default",
				expectedRevision: 3,
			});
			expect(removed.status).toBe(200);
			expect(removed.data.canvas.nodes).toEqual([idea]);
			expect(removed.data.canvas.edges).toEqual([]);
			expect(
				(await request(`/api/agent/sessions?scope=canvas&namespace=default&canvasId=${board.id}`)).data.sessions,
			).toEqual([]);
			await expect(access(runtime)).rejects.toThrow();
			await expect(access(upload)).rejects.toThrow();
			await expect(access(resultFile)).rejects.toThrow();
			const copiedRuntime = join(
				root,
				".paper-agent",
				"web-agent-memory",
				"pi-sessions",
				`runtime_${copiedSessionId}.jsonl`,
			);
			await writeFile(copiedRuntime, "runtime state");
			expect(
				(
					await request(`/api/canvases/${copy.data.canvas.id}`, "DELETE", {
						namespace: "default",
						expectedRevision: copy.data.canvas.revision,
					})
				).status,
			).toBe(200);
			await expect(access(copiedRuntime)).rejects.toThrow();
			expect(
				(await request(`/api/agent/sessions?scope=canvas&namespace=default&canvasId=${copy.data.canvas.id}`)).data
					.sessions,
			).toEqual([]);
		} finally {
			await server.close();
			await agentService.close();
			await application.close();
		}
	});
});
