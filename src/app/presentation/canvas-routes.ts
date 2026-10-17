import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebAgentServiceApi } from "../../agent/domain/web-agent-contracts.ts";
import { CanvasDocumentError } from "../../canvas/domain/research-canvas.ts";
import { CanvasRevisionConflict, ResearchCanvasStore } from "../../canvas/infrastructure/research-canvas-store.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { handleCanvasResearchRoutes } from "./canvas-research-routes.ts";
import { ApiError, json, namespaceValue, readJson } from "./web-http.ts";

export async function handleCanvasRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	agentService?: WebAgentServiceApi,
	openStreams?: Set<ServerResponse>,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/canvases")) return false;
	if (await handleCanvasResearchRoutes(application, request, response, url, agentService, openStreams)) return true;
	const body = request.method === "GET" ? undefined : await readJson(request);
	const namespace =
		namespaceValue(body?.namespace ?? url.searchParams.get("namespace")) ?? application.defaultNamespace;
	const personal = application.personalStore(namespace);
	await personal.initialize();
	const store = new ResearchCanvasStore(personal.databasePath, namespace);
	const match = /^\/api\/canvases\/([^/]+)$/.exec(url.pathname);
	const id = match ? decodeURIComponent(match[1]) : undefined;
	const copyMatch = /^\/api\/canvases\/([^/]+)\/copy$/.exec(url.pathname);
	const copyId = copyMatch ? decodeURIComponent(copyMatch[1]) : undefined;
	const sessionMatch = /^\/api\/canvases\/([^/]+)\/agent-sessions\/([^/]+)$/.exec(url.pathname);
	try {
		if (request.method === "GET" && url.pathname === "/api/canvases") {
			json(response, 200, { namespace, canvases: store.list() });
			return true;
		}
		if (request.method === "POST" && url.pathname === "/api/canvases") {
			if (typeof body?.title !== "string") throw new ApiError(400, "title is required");
			json(response, 201, { canvas: store.create(body.title) });
			return true;
		}
		if (request.method === "POST" && copyId) {
			if (!Number.isSafeInteger(body?.expectedRevision) || (body?.expectedRevision as number) < 0)
				throw new ApiError(400, "expectedRevision is required");
			const canvas = store.duplicate(copyId, body?.expectedRevision as number);
			if (!canvas) throw new ApiError(404, "画布不存在");
			const agentNodes = canvas.nodes.filter((node) => node.kind === "agent");
			if (agentNodes.length && !agentService) {
				store.delete(canvas.id, canvas.revision);
				throw new ApiError(503, "Agent 服务不可用，无法复制会话节点");
			}
			const createdSessions: string[] = [];
			let copied = canvas;
			try {
				const replacements = new Map<string, string>();
				for (const node of agentNodes) {
					const session = await agentService!.createSession({
						mode: "persistent",
						title: node.title || "Agent 对话",
						context: { kind: "canvas", namespace, canvasId: canvas.id },
					});
					createdSessions.push(session.id);
					replacements.set(node.id, session.id);
				}
				if (agentNodes.length) {
					copied = store.update(canvas.id, canvas.revision, {
						...canvas,
						nodes: canvas.nodes.map((node) =>
							replacements.has(node.id) ? { ...node, entityId: replacements.get(node.id) } : node,
						),
					})!;
				}
			} catch (error) {
				for (const id of createdSessions) await agentService?.deleteSession(id);
				store.delete(canvas.id, copied.revision);
				throw error;
			}
			json(response, 201, { canvas: copied });
			return true;
		}
		if (request.method === "DELETE" && sessionMatch) {
			if (!agentService) throw new ApiError(503, "Agent 服务不可用");
			if (!Number.isSafeInteger(body?.expectedRevision) || (body?.expectedRevision as number) < 0)
				throw new ApiError(400, "expectedRevision is required");
			const canvasId = decodeURIComponent(sessionMatch[1]);
			const sessionId = decodeURIComponent(sessionMatch[2]);
			const session = await agentService.getSession(sessionId);
			if (
				session.context?.kind !== "canvas" ||
				session.context.namespace !== namespace ||
				session.context.canvasId !== canvasId
			)
				throw new ApiError(404, "画布会话不存在");
			const source = store.get(canvasId);
			if (!source) throw new ApiError(404, "画布不存在");
			const removedIds = new Set(
				source.nodes.filter((node) => node.kind === "agent" && node.entityId === sessionId).map((node) => node.id),
			);
			const canvas = removedIds.size
				? store.update(canvasId, body?.expectedRevision as number, {
						...source,
						nodes: source.nodes.filter((node) => !removedIds.has(node.id)),
						edges: source.edges.filter((edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to)),
					})
				: source;
			if (!canvas) throw new ApiError(404, "画布不存在");
			if (!removedIds.size && source.revision !== body?.expectedRevision)
				throw new CanvasRevisionConflict("画布已在其他页面修改，请刷新后再删除会话。");
			await agentService.deleteSession(sessionId);
			json(response, 200, { canvas });
			return true;
		}
		if (request.method === "GET" && id) {
			const canvas = store.get(id);
			if (!canvas) throw new ApiError(404, "画布不存在");
			const paperIds = [
				...new Set(canvas.nodes.filter((node) => node.kind === "paper").map((node) => node.entityId as string)),
			];
			const noteIds = [
				...new Set(canvas.nodes.filter((node) => node.kind === "note").map((node) => node.entityId as string)),
			];
			const [papers, notes] = await Promise.all([
				Promise.all(paperIds.map((paperId) => personal.getPaper(paperId))),
				Promise.all(noteIds.map((noteId) => personal.getResearchNote(noteId))),
			]);
			json(response, 200, {
				canvas,
				references: {
					papers: papers.filter((paper) => paper !== undefined),
					notes: notes.filter((note) => note !== undefined).map(({ markdown: _markdown, ...note }) => note),
				},
			});
			return true;
		}
		if (request.method === "PUT" && id) {
			if (!Number.isSafeInteger(body?.expectedRevision) || (body?.expectedRevision as number) < 0)
				throw new ApiError(400, "expectedRevision is required");
			const document = body?.document as { nodes?: Array<{ kind?: string; entityId?: string }> } | undefined;
			for (const node of document?.nodes ?? []) {
				if (node.kind !== "agent" || !node.entityId) continue;
				if (!agentService) throw new ApiError(503, "Agent 服务不可用");
				const session = await agentService.getSession(node.entityId);
				if (
					session.context?.kind !== "canvas" ||
					session.context.namespace !== namespace ||
					session.context.canvasId !== id
				) {
					throw new ApiError(400, "Agent 会话不属于这张画布");
				}
			}
			const canvas = store.update(id, body?.expectedRevision as number, body?.document);
			if (!canvas) throw new ApiError(404, "画布不存在");
			json(response, 200, { canvas });
			return true;
		}
		if (request.method === "PATCH" && id) {
			if (!Number.isSafeInteger(body?.expectedRevision) || (body?.expectedRevision as number) < 0)
				throw new ApiError(400, "expectedRevision is required");
			if (typeof body?.title !== "string") throw new ApiError(400, "title is required");
			const canvas = store.rename(id, body?.expectedRevision as number, body.title);
			if (!canvas) throw new ApiError(404, "画布不存在");
			json(response, 200, { canvas });
			return true;
		}
		if (request.method === "DELETE" && id) {
			if (!Number.isSafeInteger(body?.expectedRevision) || (body?.expectedRevision as number) < 0)
				throw new ApiError(400, "expectedRevision is required");
			if (!store.delete(id, body?.expectedRevision as number)) throw new ApiError(404, "画布不存在");
			await agentService?.deleteCanvasSessions(namespace, id);
			json(response, 200, { deleted: true });
			return true;
		}
		throw new ApiError(404, "画布接口不存在");
	} catch (error) {
		if (error instanceof CanvasRevisionConflict) throw new ApiError(409, error.message);
		if (error instanceof CanvasDocumentError) throw new ApiError(400, error.message);
		if (error instanceof ApiError) throw error;
		throw error;
	}
}
