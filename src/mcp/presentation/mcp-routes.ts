import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, json, readJson } from "../../app/presentation/web-http.ts";
import type { McpControl } from "../domain/mcp.ts";
import { McpError } from "../domain/mcp.ts";

export async function handleMcpRoutes(
	control: McpControl | undefined,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/mcp")) return false;
	if (!control) throw new ApiError(503, "当前服务未启用 MCP");
	try {
		if (request.method === "GET" && url.pathname === "/api/mcp") {
			json(response, 200, await control.view());
			return true;
		}
		if (request.method === "PUT" && url.pathname === "/api/mcp") {
			const body = await readJson(request);
			if (typeof body.expectedVersion !== "string") throw new ApiError(400, "需要当前配置的 expectedVersion");
			json(response, 200, await control.save(body.config, body.expectedVersion));
			return true;
		}
		const match = /^\/api\/mcp\/([A-Za-z][A-Za-z0-9_-]{0,31})\/(test|disconnect)$/.exec(url.pathname);
		if (request.method === "POST" && match) {
			json(response, 200, await (match[2] === "test" ? control.test(match[1]) : control.disconnect(match[1])));
			return true;
		}
		throw new ApiError(404, "MCP 接口不存在");
	} catch (error) {
		if (error instanceof McpError) throw new ApiError(error.status, error.message);
		throw error;
	}
}
