import type { IncomingMessage, ServerResponse } from "node:http";
import { type CreateQuickNoteInput, QuickNoteError } from "../../quick-notes/domain/quick-note.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json, readJson } from "./web-http.ts";

export async function handleQuickNoteRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname !== "/api/quick-notes" && !url.pathname.startsWith("/api/quick-notes/")) return false;
	const match = /^\/api\/quick-notes\/([^/]+)$/.exec(url.pathname);
	const id = match ? decodeURIComponent(match[1]) : undefined;
	const service = application.quickNotes();
	try {
		if (request.method === "GET" && !id && url.pathname === "/api/quick-notes") {
			json(
				response,
				200,
				await service.list({
					query: url.searchParams.get("query") || undefined,
					paperId: url.searchParams.get("paperId") || undefined,
					page: url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined,
					pageSize: url.searchParams.has("pageSize") ? Number(url.searchParams.get("pageSize")) : undefined,
				}),
			);
		} else if (request.method === "GET" && id) {
			json(response, 200, { note: await service.get(id) });
		} else if (request.method === "POST" && url.pathname === "/api/quick-notes") {
			json(response, 201, {
				note: await service.create((await readJson(request)) as unknown as CreateQuickNoteInput),
			});
		} else if (request.method === "PATCH" && id) {
			const body = await readJson(request);
			json(response, 200, {
				note: await service.update(id, body.content as string, body.expectedRevision as number),
			});
		} else if (request.method === "DELETE" && id) {
			await service.delete(id);
			json(response, 200, { deleted: true });
		} else throw new ApiError(404, "随手记接口不存在");
		return true;
	} catch (error) {
		if (error instanceof QuickNoteError) throw new ApiError(error.status, error.message);
		throw error;
	}
}
