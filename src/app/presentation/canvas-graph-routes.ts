import type { IncomingMessage, ServerResponse } from "node:http";
import { canvasGraph } from "../../canvas/application/canvas-graph-service.ts";
import { ResearchCanvasStore } from "../../canvas/infrastructure/research-canvas-store.ts";
import { CanvasGraphStore } from "../../canvas/infrastructure/canvas-graph-store.ts";
import type { CanvasGraphState } from "../../canvas/domain/canvas-graph.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json, readJson } from "./web-http.ts";

export async function handleCanvasGraphRoutes(
	app: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
) {
	const match = /^\/api\/canvases\/([^/]+)\/graph(?:\/(.*))?$/.exec(url.pathname);
	if (!match) return false;
	const canvasId = decodeURIComponent(match[1]),
		route = match[2] ?? "";
	const library = app.personalStore();
	await library.initialize();
	if (!new ResearchCanvasStore(library.databasePath).get(canvasId)) throw new ApiError(404, "画布不存在");
	try {
		if (request.method === "GET") {
			if (!route) json(response, 200, await canvasGraph(library, canvasId));
			else if (route === "state") json(response, 200, new CanvasGraphStore(library.databasePath, canvasId).state());
			else if (route.startsWith("papers/"))
				json(response, 200, await canvasGraph(library, canvasId, decodeURIComponent(route.slice(7))));
			else throw new ApiError(404, "图谱接口不存在");
		} else if (request.method === "POST" || request.method === "PATCH") {
			const body = await readJson(request);
			if (route === "state")
				json(
					response,
					200,
					new CanvasGraphStore(library.databasePath, canvasId).saveState(body as unknown as CanvasGraphState),
				);
			else throw new ApiError(404, "图谱接口不存在");
		} else throw new ApiError(405, "不支持此请求方法");
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(400, error instanceof Error ? error.message : String(error));
	}
	return true;
}
