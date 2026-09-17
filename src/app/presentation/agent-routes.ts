import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { normalizePermissionMode, normalizeThinkingLevel } from "../../agent/application/web-agent-support.ts";
import type {
	WebAgentConfigUpdate,
	WebAgentEvent,
	WebAgentMode,
	WebAgentServiceApi,
	WebAgentSessionContext,
	WebAgentSessionFilter,
} from "../../agent/domain/web-agent-contracts.ts";
import {
	type AutomatedResearchDepth,
	type AutomatedResearchPlan,
	automatedResearchDepth,
	automatedResearchPrompt,
	automatedResearchThinkingLevel,
} from "../../research/application/research-automation.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json, readJson } from "./web-http.ts";

export interface AgentRouteContext {
	request: IncomingMessage;
	response: ServerResponse;
	url: URL;
	agentService?: WebAgentServiceApi;
	openStreams: Set<ServerResponse>;
}

/**
 * POST /api/agent/research/start —— 个人库论文"一键研究"入口。
 * 需要同时访问 application（读论文详情与本地 PDF）和 agentService（创建会话），
 * 因此在 local-web-server 的 /api/agent/ 分发之前单独调用。
 */
export async function handleAgentResearchLaunch(
	application: PaperAgentApplication,
	agentService: WebAgentServiceApi,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (request.method !== "POST" || url.pathname !== "/api/agent/research/start") return false;
	const body = await readJson(request);
	const paperId = typeof body.paperId === "string" ? body.paperId.trim() : "";
	const namespace = typeof body.namespace === "string" ? body.namespace.trim() : "";
	if (!paperId) throw new ApiError(400, "请先选择一篇个人库论文");
	if (!namespace) throw new ApiError(400, "个人库 namespace 不能为空");
	const details = await application.paperDetails(paperId, namespace);
	if (!details) throw new ApiError(404, "个人库中找不到这篇论文，请刷新页面后重试");
	const version = details.versions
		.filter((candidate) => candidate.versionKind !== "translation")
		.sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt))[0];
	if (!version) {
		throw new ApiError(409, "这篇论文还没有本地 PDF。请先在个人库获取 PDF 原文，等待任务完成后再开始自动研究。");
	}
	const pdfFile = await stat(version.blobPath).catch(() => undefined);
	if (!pdfFile?.isFile()) {
		throw new ApiError(409, `本地 PDF 原件已丢失（${version.blobPath}），请在个人库重新获取后再开始自动研究`);
	}
	const config = await agentService.getConfig();
	if (!config.configured || !config.credentialsAvailable) {
		throw new ApiError(
			409,
			"自动研究需要可用的模型。请先打开“Agent 对话”，填写 Provider、Model、Base URL 和临时 API key，并应用配置。",
		);
	}
	let depth: AutomatedResearchDepth;
	try {
		depth = automatedResearchDepth(body.depth);
	} catch (error) {
		throw new ApiError(400, error instanceof Error ? error.message : String(error));
	}
	const automationRequest = {
		paperId,
		namespace,
		depth,
		researchQuestion: typeof body.researchQuestion === "string" ? body.researchQuestion : undefined,
		discoverArtifacts: body.discoverArtifacts !== false,
	};
	let automation: { prompt: string; plan: AutomatedResearchPlan };
	try {
		automation = automatedResearchPrompt({
			request: automationRequest,
			paper: details.paper,
			version,
			localPdfPath: version.blobPath,
		});
	} catch (error) {
		throw new ApiError(400, error instanceof Error ? error.message : String(error));
	}
	// 思考强度：请求可显式指定；否则按研究深度给默认（quick→low、methods→medium、full/reproduce→high）。
	const thinkingLevel = normalizeThinkingLevel(body.thinkingLevel) ?? automatedResearchThinkingLevel(depth);
	// 复用已有会话，避免每次自动研究都新建会话；只有确实没有可用会话时才新建。
	// 优先同一篇论文关联的会话，其次才回退到该个人库内最近的其它会话。
	// listSessions 按 updatedAt 倒序，因此每条候选中第一条即为最近一次。
	// 不自动发送：研究指令只作为待发送草稿返回，由用户确认后手动发送。
	const usableSessions = (await Promise.resolve(agentService.listSessions({ scope: "personal", namespace }))).filter(
		(candidate) => candidate.status !== "running" && candidate.status !== "stopping",
	);
	const reusableSession =
		usableSessions.find((candidate) => candidate.context?.paperId === paperId) ?? usableSessions[0];
	let session: Awaited<ReturnType<WebAgentServiceApi["createSession"]>>;
	if (reusableSession) {
		session = await agentService.getSession(reusableSession.id);
	} else {
		session = await agentService.createSession({
			mode: "persistent",
			title: `自动研究 · ${details.paper.title}`.slice(0, 120),
			thinkingLevel,
			// 绑定当前论文作用域，使该会话能被个人库范围检索到并在下次自动研究时复用。
			context: { kind: "paper", namespace, paperId },
		});
	}
	json(response, 200, {
		session,
		plan: automation.plan,
		thinkingLevel,
		draft: automation.prompt,
		reusedExistingSession: Boolean(reusableSession),
	});
	return true;
}

export async function handleAgentRoutes(context: AgentRouteContext): Promise<void> {
	const { request, response, url, agentService } = context;
	if (!agentService) throw new ApiError(503, "Web Agent service is unavailable");
	if (request.method === "GET" && url.pathname === "/api/agent/config") {
		json(response, 200, await agentService.getConfig());
		return;
	}
	if (request.method === "PUT" && url.pathname === "/api/agent/config") {
		json(
			response,
			200,
			await agentService.updateConfig((await readJson(request)) as unknown as WebAgentConfigUpdate),
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/agent/config/apply") {
		const body = await readJson(request);
		if (typeof body.key !== "string" || !body.key.trim()) throw new ApiError(400, "key must be a non-empty string");
		json(response, 200, await agentService.applyConfiguredModel(body.key.trim()));
		return;
	}
	if (request.method === "DELETE" && url.pathname === "/api/agent/key") {
		json(response, 200, await agentService.clearKey());
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/agent/sessions") {
		json(response, 200, { sessions: await agentService.listSessions(sessionFilter(url)) });
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/agent/skills") {
		json(response, 200, { skills: await agentService.listSkills() });
		return;
	}
	if (await handleResultDocument(request, response, url, agentService)) return;
	if (request.method === "POST" && url.pathname === "/api/agent/sessions") {
		const body = await readJson(request);
		const context = paperSessionContext(body.context);
		json(
			response,
			201,
			await agentService.createSession({
				mode: body.mode as WebAgentMode,
				title: typeof body.title === "string" ? body.title : undefined,
				context,
				thinkingLevel: normalizeThinkingLevel(body.thinkingLevel),
				permissionMode: normalizePermissionMode(body.permissionMode),
			}),
		);
		return;
	}
	if (await handleSessionAction(context, agentService)) return;
	throw new ApiError(404, "Agent API route not found");
}

function sessionFilter(url: URL): WebAgentSessionFilter {
	const scope = url.searchParams.get("scope");
	if (!scope || scope === "general") return { scope: "general" };
	if (scope !== "paper" && scope !== "personal") {
		throw new ApiError(400, "scope must be general, paper, or personal");
	}
	const namespace = url.searchParams.get("namespace")?.trim();
	if (scope === "personal") {
		if (!namespace) throw new ApiError(400, "personal scope requires namespace");
		return { scope: "personal", namespace };
	}
	const paperId = url.searchParams.get("paperId")?.trim();
	if (!namespace || !paperId) throw new ApiError(400, "paper scope requires namespace and paperId");
	return { scope: "paper", namespace, paperId };
}

function paperSessionContext(value: unknown): WebAgentSessionContext | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ApiError(400, "context must be an object");
	}
	const context = value as Record<string, unknown>;
	if (context.kind !== "paper" || typeof context.namespace !== "string" || typeof context.paperId !== "string") {
		throw new ApiError(400, "paper context requires kind, namespace, and paperId");
	}
	return { kind: "paper", namespace: context.namespace, paperId: context.paperId };
}

async function handleResultDocument(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	agentService: WebAgentServiceApi,
): Promise<boolean> {
	const match = /^\/api\/agent\/results\/([^/]+)$/.exec(url.pathname);
	if (request.method !== "GET" || !match) return false;
	const fileName = decodeURIComponent(match[1]);
	if (!/^[a-zA-Z0-9._-]+\.md$/.test(fileName)) throw new ApiError(400, "Invalid result document name");
	try {
		const content = await readFile(
			join(agentService.projectRoot, ".paper-agent", "web-agent-memory", "results", fileName),
			"utf8",
		);
		response.writeHead(200, {
			"content-type": "text/markdown; charset=utf-8",
			"content-length": Buffer.byteLength(content),
			"cache-control": "private, no-store",
		});
		response.end(content);
	} catch {
		throw new ApiError(404, "Result document not found");
	}
	return true;
}

async function handleSessionAction(context: AgentRouteContext, agentService: WebAgentServiceApi): Promise<boolean> {
	const { request, response, url } = context;
	const rename = /^\/api\/agent\/sessions\/([^/]+)\/rename$/.exec(url.pathname);
	if (request.method === "POST" && rename) {
		const body = await readJson(request);
		if (typeof body.title !== "string" || !body.title.trim())
			throw new ApiError(400, "title must be a non-empty string");
		json(response, 200, await agentService.renameSession(decodeURIComponent(rename[1]), body.title.trim()));
		return true;
	}
	if (await handleSessionEvents(context, agentService)) return true;
	const settings = /^\/api\/agent\/sessions\/([^/]+)\/settings$/.exec(url.pathname);
	if (request.method === "POST" && settings) {
		const body = await readJson(request);
		const thinkingLevel = normalizeThinkingLevel(body.thinkingLevel);
		const permissionMode = normalizePermissionMode(body.permissionMode);
		if (!thinkingLevel && !permissionMode) {
			throw new ApiError(400, "settings requires a valid thinkingLevel or permissionMode");
		}
		json(
			response,
			200,
			await agentService.updateSessionSettings(decodeURIComponent(settings[1]), {
				thinkingLevel,
				permissionMode,
			}),
		);
		return true;
	}
	const ui = /^\/api\/agent\/sessions\/([^/]+)\/ui\/([^/]+)\/respond$/.exec(url.pathname);
	if (request.method === "POST" && ui) {
		const body = await readJson(request);
		json(
			response,
			200,
			await agentService.respondToUI(decodeURIComponent(ui[1]), decodeURIComponent(ui[2]), body.value),
		);
		return true;
	}
	if (await handleMessageAction(context, agentService)) return true;
	if (await handleAttachment(context, agentService)) return true;
	const session = /^\/api\/agent\/sessions\/([^/]+)$/.exec(url.pathname);
	if (!session) return false;
	const id = decodeURIComponent(session[1]);
	if (request.method === "GET") json(response, 200, await agentService.getSession(id));
	else if (request.method === "DELETE") {
		await agentService.deleteSession(id);
		json(response, 200, { ok: true });
	} else return false;
	return true;
}

async function handleSessionEvents(context: AgentRouteContext, agentService: WebAgentServiceApi): Promise<boolean> {
	const { request, response, url, openStreams } = context;
	const match = /^\/api\/agent\/sessions\/([^/]+)\/events$/.exec(url.pathname);
	if (request.method !== "GET" || !match) return false;
	let writeEvent = (_event: string, _value: unknown, _eventId?: number) => undefined;
	// Events can arrive between subscribing and the socket being writable. Dropping them would
	// silently lose reasoning/message deltas on every reconnect, so hold and replay them in order.
	const buffered: Array<[string, unknown, number | undefined]> = [];
	let writable = false;
	const subscription = agentService.subscribeSession(decodeURIComponent(match[1]), (event: WebAgentEvent) => {
		if (writable) writeEvent(event.type, event, event.id);
		else buffered.push([event.type, event, event.id]);
	});
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	openStreams.add(response);
	writeEvent = (event, value, eventId) => {
		if (eventId !== undefined) response.write(`id: ${eventId}\n`);
		response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
	};
	writeEvent("snapshot", subscription.snapshot);
	writable = true;
	for (const [event, value, eventId] of buffered.splice(0)) writeEvent(event, value, eventId);
	const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
	request.once("close", () => {
		clearInterval(heartbeat);
		subscription.unsubscribe();
		openStreams.delete(response);
	});
	return true;
}

async function handleMessageAction(context: AgentRouteContext, agentService: WebAgentServiceApi): Promise<boolean> {
	const { request, response, url } = context;
	const match = /^\/api\/agent\/sessions\/([^/]+)\/(messages|abort|dismiss-error)$/.exec(url.pathname);
	if (request.method !== "POST" || !match) return false;
	const id = decodeURIComponent(match[1]);
	if (match[2] === "abort") json(response, 200, await agentService.abortSession(id));
	else if (match[2] === "dismiss-error") {
		if (!agentService.dismissError) throw new ApiError(501, "Agent error dismissal is unavailable");
		json(response, 200, await agentService.dismissError(id));
	} else {
		const body = await readJson(request);
		const attachments = Array.isArray(body.attachments)
			? body.attachments.filter(isAttachment).slice(0, 10)
			: undefined;
		json(
			response,
			202,
			await agentService.sendMessage(id, {
				message: typeof body.message === "string" ? body.message : "",
				attachments,
			}),
		);
	}
	return true;
}

function isAttachment(value: unknown): value is { path: string; name: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { path?: unknown }).path === "string" &&
		typeof (value as { name?: unknown }).name === "string"
	);
}

async function handleAttachment(context: AgentRouteContext, agentService: WebAgentServiceApi): Promise<boolean> {
	const { request, response, url } = context;
	const match = /^\/api\/agent\/sessions\/([^/]+)\/attachments$/.exec(url.pathname);
	if (request.method !== "POST" || !match) return false;
	const header = request.headers["x-filename"];
	let name = typeof header === "string" ? header : "attachment";
	try {
		name = decodeURIComponent(name);
	} catch {
		/* Keep the original header. */
	}
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	json(
		response,
		201,
		await agentService.uploadAttachment(decodeURIComponent(match[1]), {
			name,
			data: new Uint8Array(Buffer.concat(chunks)),
		}),
	);
	return true;
}
