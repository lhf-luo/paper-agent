import type { IncomingMessage, ServerResponse } from "node:http";
import { SearchRunGraphs } from "../../canvas/application/search-run-graphs.ts";
import type { CanvasGraphState } from "../../canvas/domain/canvas-graph.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json, readJson } from "./web-http.ts";

export async function handleSearchRunGraphRoutes(
	app: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
) {
	const match = /^\/api\/canvases\/([^/]+)\/search-graphs(?:\/([^/]+)(?:\/(.*))?)?$/.exec(url.pathname);
	if (!match) return false;
	const canvasId = decodeURIComponent(match[1]),
		runId = match[2] ? decodeURIComponent(match[2]) : undefined;
	const route = match[3] ?? "";
	const library = app.personalStore();
	await library.initialize();
	const graphs = new SearchRunGraphs(library, canvasId);
	try {
		if (request.method === "GET") {
			if (runId && route === "enrich") {
				json(response, 200, {
					...(await graphs.enrichmentPlan(runId)),
					job: app.jobs
						.list({ limit: 10000 })
						.find(
							(j) =>
								j.type === "search-graph-enrich" &&
								(j.input as { canvasId: string; runId: string }).canvasId === canvasId &&
								(j.input as { runId: string }).runId === runId,
						),
				});
				return true;
			}
			if (runId && route === "evidence") {
				const research = await graphs.research(runId);
				const edge = research.relations.find((e) => e.id === url.searchParams.get("edgeId"));
				if (!edge) throw new Error("关系不存在");
				json(response, 200, edge);
				return true;
			}
			if (route && !/^papers\/[^/]+$/.test(route)) throw new Error("搜索图谱路径无效");
			if (!runId) json(response, 200, { graphs: graphs.views.list().map(({ state: _state, ...r }) => r) });
			else
				json(
					response,
					200,
					await graphs.graph(runId, route.startsWith("papers/") ? decodeURIComponent(route.slice(7)) : undefined),
				);
		} else {
			const body = await readJson(request);
			if (request.method === "POST" && runId && route === "enrich") {
				const budget = body.budget === undefined ? 100 : Number(body.budget);
				if (!Number.isSafeInteger(budget) || budget < 1 || budget > 100) throw new Error("请求预算必须为 1–100");
				json(response, 200, await app.enqueueSearchGraphEnrichment(canvasId, runId, budget));
				return true;
			}
			if (request.method === "POST" && runId && ["layout", "restore-layout"].includes(route)) {
				json(response, 200, graphs.applyLayout(runId, route === "restore-layout"));
				return true;
			}
			if (request.method === "POST" && !runId && typeof body.searchRunId === "string")
				json(
					response,
					200,
					await graphs.show(
						body.searchRunId,
						"user",
						typeof body.filterResultId === "string" ? body.filterResultId : undefined,
					),
				);
			else if (request.method === "PATCH" && runId && !route) {
				const view = graphs.views.get(runId);
				if (!view) throw new Error("搜索图谱不存在");
				if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 300)
					throw new Error("图谱名称须为 1–300 个字符");
				graphs.views.save({ ...view, title: body.title.trim() });
				json(response, 200, { updated: true });
			} else if (request.method === "POST" && runId && route === "open") {
				const view = graphs.views.get(runId);
				if (!view) throw new Error("搜索图谱不存在");
				graphs.views.save({
					...view,
					closed: false,
					openedAt: new Date(Math.max(Date.now(), Date.parse(view.openedAt) + 1)).toISOString(),
				});
				json(response, 200, { opened: true });
			} else if (request.method === "PATCH" && runId && route === "state")
				json(response, 200, graphs.saveState(runId, body as unknown as CanvasGraphState));
			else if (request.method === "POST" && runId && route === "close") {
				const view = graphs.views.get(runId);
				if (!view) throw new Error("搜索图谱不存在");
				graphs.views.save({ ...view, closed: true });
				json(response, 200, { closed: true });
			} else throw new ApiError(400, "搜索图谱请求无效");
		}
	} catch (error) {
		throw new ApiError(400, error instanceof Error ? error.message : String(error));
	}
	return true;
}
