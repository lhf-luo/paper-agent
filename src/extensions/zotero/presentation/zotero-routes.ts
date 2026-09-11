import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaperAgentApplication } from "../../../app/application/paper-agent-application.ts";
import { ApiError, grantFromBody, json, namespaceValue, readJson } from "../../../app/presentation/web-http.ts";

export async function handleZoteroRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/zotero/")) return false;
	if (request.method === "GET" && url.pathname === "/api/zotero/status") {
		json(response, 200, await application.zoteroStatus());
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/zotero/authorize") {
		json(response, 200, await application.authorizeZotero());
		return true;
	}
	if (request.method === "GET" && url.pathname === "/api/zotero/collections") {
		json(response, 200, await application.listZoteroCollections());
		return true;
	}
	if (request.method === "GET" && url.pathname === "/api/zotero/items") {
		json(response, 200, await application.listZoteroItems(url.searchParams.get("q") ?? undefined));
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/zotero/imports/prepare") {
		const body = await readJson(request);
		json(
			response,
			200,
			await application.prepareZoteroImport({ ...body, namespace: namespaceValue(body.namespace) }),
		);
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/zotero/exports/prepare") {
		const body = await readJson(request);
		json(
			response,
			200,
			await application.prepareZoteroExport({ ...body, namespace: namespaceValue(body.namespace) }),
		);
		return true;
	}
	const importItem = /^\/api\/zotero\/imports\/([^/]+)\/items\/([^/]+)$/.exec(url.pathname);
	if (importItem && request.method === "POST") {
		const body = await readJson(request);
		json(
			response,
			200,
			await application.executeZoteroImportItem(
				decodeURIComponent(importItem[1]),
				decodeURIComponent(importItem[2]),
				grantFromBody(body),
			),
		);
		return true;
	}
	const operation = /^\/api\/zotero\/(imports|exports)\/([^/]+)$/.exec(url.pathname);
	if (!operation) throw new ApiError(404, "Zotero API route not found");
	const operationId = decodeURIComponent(operation[2]);
	if (request.method === "DELETE") {
		if (operation[1] === "imports") await application.cancelZoteroImport(operationId);
		else await application.cancelZoteroExport(operationId);
		json(response, 200, { ok: true });
		return true;
	}
	if (request.method === "POST") {
		const body = await readJson(request);
		json(
			response,
			200,
			operation[1] === "imports"
				? await application.executeZoteroImport(operationId, grantFromBody(body))
				: await application.executeZoteroExport(operationId, grantFromBody(body)),
		);
		return true;
	}
	throw new ApiError(405, "Method not allowed");
}
