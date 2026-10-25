import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json, readJson, integerValue } from "./web-http.ts";
export async function handleCanvasExpansionRoutes(
	app: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
) {
	const match = /^\/api\/canvases\/([^/]+)\/expansions$/.exec(url.pathname);
	if (!match) return false;
	try {
		if (request.method !== "POST") throw new Error("请使用 POST 启动扩展");
		const body = await readJson(request);
		if (typeof body.paperId !== "string" || typeof body.requestId !== "string") throw new Error("缺少论文或请求标识");
		if (body.kind !== "citation" && body.kind !== "author") throw new Error("扩展类型无效");
		const direction = body.direction ?? "both";
		if (!["references", "citations", "both"].includes(String(direction))) throw new Error("扩展方向无效");
		if (body.authorName !== undefined && typeof body.authorName !== "string") throw new Error("作者名称无效");
		const input = {
			canvasId: decodeURIComponent(match[1]),
			paperId: body.paperId,
			requestId: body.requestId,
			kind: body.kind as "citation" | "author",
			direction: direction as "references" | "citations" | "both",
			authorName: body.authorName as string | undefined,
			yearFrom: integerValue(body.yearFrom, "yearFrom", 1000, 9999),
			yearTo: integerValue(body.yearTo, "yearTo", 1000, 9999),
			limit: integerValue(body.limit, "limit", 1, 100) ?? 30,
		};
		json(response, 202, await app.enqueueCanvasExpansion(input));
		return true;
	} catch (error) {
		throw new ApiError(400, error instanceof Error ? error.message : String(error));
	}
}
