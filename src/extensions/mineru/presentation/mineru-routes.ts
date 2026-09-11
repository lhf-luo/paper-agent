import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import type { PaperAgentApplication } from "../../../app/application/paper-agent-application.ts";
import { grantFromBody, json, readJson } from "../../../app/presentation/web-http.ts";

const materialRoute =
	/^\/api\/papers\/([^/]+)\/mineru(?:\/(content|asset|open|prepare|execute|delete\/prepare|delete\/execute))?$/;

function namespace(url: URL): string | undefined {
	return url.searchParams.get("namespace")?.trim() || undefined;
}

function pages(value: string | null): number[] | undefined {
	if (!value) return undefined;
	const result = new Set<number>();
	for (const part of value.split(",")) {
		const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
		if (!match) throw new Error("pages must use values such as 1,3-5");
		const first = Number(match[1]);
		const last = Number(match[2] ?? match[1]);
		if (first < 1 || last < first || last - first > 20) throw new Error("pages contains an invalid range");
		for (let page = first; page <= last && result.size < 20; page += 1) result.add(page);
	}
	return [...result];
}

export async function handleMineruRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (request.method === "GET" && url.pathname === "/api/mineru/status") {
		json(response, 200, await application.mineruStatus());
		return true;
	}
	const cancelledOperation = /^\/api\/mineru\/operations\/([^/]+)$/.exec(url.pathname);
	if (request.method === "DELETE" && cancelledOperation) {
		json(response, 200, await application.cancelMineru(decodeURIComponent(cancelledOperation[1])));
		return true;
	}
	const match = materialRoute.exec(url.pathname);
	if (!match) return false;
	const paperId = decodeURIComponent(match[1]);
	const action = match[2];
	const targetNamespace = namespace(url) ?? application.defaultNamespace;
	if (request.method === "GET" && !action) {
		json(response, 200, await application.mineruMaterial(paperId, targetNamespace));
		return true;
	}
	if (request.method === "GET" && action === "content") {
		json(
			response,
			200,
			await application.mineru.read(paperId, targetNamespace, {
				mode: (url.searchParams.get("mode") as "overview" | "pages" | "search" | null) ?? undefined,
				pages: pages(url.searchParams.get("pages")),
				query: url.searchParams.get("query") ?? undefined,
			}),
		);
		return true;
	}
	if (request.method === "GET" && action === "asset") {
		const asset = await application.mineru.readAsset(paperId, targetNamespace, url.searchParams.get("path") ?? "");
		const mime =
			(
				{ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<
					string,
					string
				>
			)[extname(asset.path).toLowerCase()] ?? "application/octet-stream";
		response.writeHead(200, {
			"content-type": mime,
			"content-length": asset.body.length,
			"cache-control": "private, no-store",
		});
		response.end(asset.body);
		return true;
	}
	if (request.method === "POST" && action === "prepare") {
		const body = await readJson(request);
		json(
			response,
			200,
			await application.prepareMineru({ paperId, namespace: targetNamespace, force: body.force === true }),
		);
		return true;
	}
	if (request.method === "POST" && action === "execute") {
		json(response, 202, await application.enqueueAuthorizedMineru(grantFromBody(await readJson(request))));
		return true;
	}
	if (request.method === "POST" && action === "open") {
		json(response, 200, await application.mineru.openFolder(paperId, targetNamespace));
		return true;
	}
	if (request.method === "POST" && action === "delete/prepare") {
		json(response, 200, await application.mineru.prepareDelete(paperId, targetNamespace));
		return true;
	}
	if (request.method === "POST" && action === "delete/execute") {
		json(response, 200, await application.mineru.executeDelete(grantFromBody(await readJson(request))));
		return true;
	}
	return false;
}
