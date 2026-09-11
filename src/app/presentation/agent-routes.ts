import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type {
	WebAgentConfigUpdate,
	WebAgentEvent,
	WebAgentMode,
	WebAgentSessionContext,
	WebAgentSessionFilter,
	WebAgentServiceApi,
} from "../../agent/domain/web-agent-contracts.ts";
import { ApiError, json, readJson } from "./web-http.ts";

export interface AgentRouteContext {
	request: IncomingMessage;
	response: ServerResponse;
	url: URL;
	agentService?: WebAgentServiceApi;
	openStreams: Set<ServerResponse>;
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
	if (scope !== "paper") throw new ApiError(400, "scope must be general or paper");
	const namespace = url.searchParams.get("namespace")?.trim();
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
	const subscription = agentService.subscribeSession(decodeURIComponent(match[1]), (event: WebAgentEvent) =>
		writeEvent(event.type, event, event.id),
	);
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
