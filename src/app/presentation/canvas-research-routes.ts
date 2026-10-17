import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebAgentServiceApi } from "../../agent/domain/web-agent-contracts.ts";
import type { ResearchLayout } from "../../canvas/application/canvas-research-layout.ts";
import { latestResearchAnalysis } from "../../canvas/application/canvas-research-projection.ts";
import { previewPaperSelection, previewResearchRelations } from "../../canvas/application/canvas-research-proposals.ts";
import { CanvasResearchSearch } from "../../canvas/application/canvas-research-search.ts";
import { CanvasResearchService } from "../../canvas/application/canvas-research-service.ts";
import type {
	CanvasChangeProposal,
	CanvasResearchAnalysis,
	CanvasSearchPlan,
} from "../../canvas/domain/canvas-research.ts";
import { integer, strings, text } from "../../canvas/domain/canvas-research-validation.ts";
import { subscribeCanvasResearch } from "../../canvas/infrastructure/canvas-research-events.ts";
import { CanvasRevisionConflict } from "../../canvas/infrastructure/research-canvas-store.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json, namespaceValue, readJson } from "./web-http.ts";

export async function handleCanvasResearchRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	agentService?: WebAgentServiceApi,
	openStreams?: Set<ServerResponse>,
): Promise<boolean> {
	const match = /^\/api\/canvases\/([^/]+)\/research\/(.+)$/.exec(url.pathname);
	if (!match) return false;
	if (
		!["GET", "POST", "PATCH"].includes(request.method ?? "") ||
		(request.method === "PATCH" && match[2] !== "settings")
	)
		throw new ApiError(405, "研究接口不支持此请求方法");
	const body = request.method === "GET" ? {} : await readJson(request);
	const namespace =
		namespaceValue(body.namespace ?? url.searchParams.get("namespace")) ?? application.defaultNamespace;
	const sessionId =
		typeof body.sessionId === "string" ? body.sessionId : (url.searchParams.get("sessionId") ?? "user");
	const canvasId = decodeURIComponent(match[1]);
	if (sessionId !== "user") {
		const session = await agentService?.getSession(sessionId);
		if (
			session?.context?.kind !== "canvas" ||
			session.context.namespace !== namespace ||
			session.context.canvasId !== canvasId
		)
			throw new ApiError(404, "会话不属于此画布");
	}
	const library = application.personalStore(namespace);
	await library.initialize();
	const service = new CanvasResearchService(library, namespace, canvasId, sessionId);
	if (!service.canvases.get(canvasId)) throw new ApiError(404, "画布不存在");
	try {
		if (request.method === "GET") await readRoute(service, match[2], url, response, request, openStreams);
		else await writeRoute(service, match[2], body, response);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(
			error instanceof CanvasRevisionConflict ? 409 : 400,
			error instanceof Error ? error.message : String(error),
		);
	}
	return true;
}

async function readRoute(
	service: CanvasResearchService,
	route: string,
	url: URL,
	response: ServerResponse,
	request: IncomingMessage,
	openStreams?: Set<ServerResponse>,
) {
	const offset = integer(Number(url.searchParams.get("offset") ?? 0), 0, 100000);
	const limit = integer(Number(url.searchParams.get("limit") ?? 50), 1, 50);
	if (route === "events") {
		openStreams?.add(response);
		response.on("close", () => openStreams?.delete(response));
		return streamEvents(service, request, response);
	}
	if (route === "settings") return json(response, 200, service.settings());
	if (route === "scope") return json(response, 200, service.context());
	if (route === "overview") return json(response, 200, await service.overview());
	if (route === "nodes") return json(response, 200, await service.nodes(offset, limit));
	if (route === "proposals")
		return json(response, 200, {
			proposals: service.records
				.list<CanvasChangeProposal>("proposal")
				.slice(offset, offset + limit)
				.map(({ value, ...r }) => ({ ...r, value: { ...value, before: undefined, after: undefined } })),
		});
	if (route === "analyses") {
		if (url.searchParams.get("latest") === "matching")
			return json(response, 200, { analysis: await latestResearchAnalysis(service) });
		const id = url.searchParams.get("id");
		if (id) return json(response, 200, await service.analysis(id, offset, limit));
		const records = service.records.list<CanvasResearchAnalysis>("analysis");
		return json(response, 200, {
			total: records.length,
			analyses: records.slice(offset, offset + limit).map(({ value, ...r }) => ({
				...r,
				value: { ...value, cards: undefined, relations: undefined, sources: undefined },
			})),
		});
	}
	if (route === "searches")
		return json(response, 200, {
			plans: service.records.list<CanvasSearchPlan>("search").slice(offset, offset + limit),
		});
	const candidates = /^searches\/([^/]+)\/candidates$/.exec(route);
	if (candidates) return readCandidates(service, decodeURIComponent(candidates[1]), url, response, offset, limit);
	throw new ApiError(404, "研究接口不存在");
}

async function readCandidates(
	service: CanvasResearchService,
	id: string,
	url: URL,
	response: ServerResponse,
	offset: number,
	limit: number,
) {
	const plan = service.records.get<CanvasSearchPlan>("search", id);
	const runId = url.searchParams.get("runId") ?? plan?.value.searchRunIds[0];
	if (!plan || !runId || !plan.value.searchRunIds.includes(runId)) throw new Error("候选检索不属于本计划");
	const run = await service.library.getSearchRun(runId);
	if (!run) throw new Error("检索记录不存在");
	return json(response, 200, {
		runId,
		total: run.results.length,
		papers: run.results.slice(offset, offset + limit),
		failures: run.failures,
		coverage: run.coverage,
		executions: run.executions,
		authorExpansion: run.authorExpansion,
		citationExpansion: run.citationExpansion,
		gaps: plan.value.gap,
		recommendations:
			service.records
				.get<CanvasResearchAnalysis>("analysis", plan.value.analysisId)
				?.value.candidates?.filter((c) => c.searchRunId === runId) ?? [],
	});
}

async function writeRoute(
	service: CanvasResearchService,
	route: string,
	body: Record<string, unknown>,
	response: ServerResponse,
) {
	if (route === "settings")
		return json(response, 200, service.saveSettings(body.settings, integer(body.expectedRevision, -1, 10000000)));
	if (route === "scope") return json(response, 200, service.saveContext(body.scope));
	if (route === "analyses")
		return json(
			response,
			200,
			await service.saveAnalysis(
				body.content ?? {},
				body.id === undefined ? undefined : text(body.id, 80),
				body.expectedRevision === undefined ? undefined : integer(body.expectedRevision, 0, 10000000),
			),
		);
	if (route === "searches") return json(response, 201, new CanvasResearchSearch(service).create(body.plan));
	const decision = /^searches\/([^/]+)\/decision$/.exec(route);
	if (decision) {
		if (typeof body.approved !== "boolean") throw new Error("请选择接受或拒绝");
		return json(
			response,
			200,
			new CanvasResearchSearch(service).decide(
				decodeURIComponent(decision[1]),
				body.approved,
				integer(body.expectedRevision, 0, 10000000),
			),
		);
	}
	if (route === "proposals") return json(response, 201, await createProposal(service, body));
	const change = /^proposals\/([^/]+)\/(apply|undo)$/.exec(route);
	if (change)
		return json(
			response,
			200,
			await service.apply(
				decodeURIComponent(change[1]),
				strings(body.selectedIds ?? [], 1000),
				integer(body.expectedRevision, 0, 10000000),
				change[2] === "undo",
			),
		);
	throw new ApiError(404, "研究接口不存在");
}

async function createProposal(service: CanvasResearchService, body: Record<string, unknown>) {
	const operations = body.operations;
	const analysisId = body.analysisId === undefined ? undefined : text(body.analysisId, 80);
	if (body.layout) {
		if (!["methods", "timeline", "evidence"].includes(String(body.layout))) throw new Error("布局类型无效");
		if (!analysisId) throw new Error("请选择分析记录");
		return service.layoutProposal(
			body.layout as ResearchLayout,
			analysisId,
			text(body.reason ?? "研究画布编排建议", 4000),
		);
	}
	const reason = text(body.reason ?? "研究画布编排建议", 4000);
	if (body.relations === true) {
		if (!analysisId) throw new Error("请选择分析记录");
		return previewResearchRelations(service, analysisId, reason);
	}
	if (Array.isArray(body.paperIds)) return previewPaperSelection(service, strings(body.paperIds), reason);
	return service.preview({ reason: text(body.reason ?? "研究画布编排建议", 4000), analysisId, operations });
}

function streamEvents(service: CanvasResearchService, request: IncomingMessage, response: ServerResponse) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const send = () => {
		if (!response.destroyed) response.write(`data: ${JSON.stringify({ canvasId: service.canvasId })}\n\n`);
	};
	const unsubscribe = subscribeCanvasResearch(service.library.databasePath, service.namespace, service.canvasId, send);
	const timer = setInterval(() => {
		if (!response.destroyed) response.write(": keepalive\n\n");
	}, 15000);
	response.on("close", () => {
		clearInterval(timer);
		unsubscribe();
	});
	request.on("error", () => response.end());
	send();
}
