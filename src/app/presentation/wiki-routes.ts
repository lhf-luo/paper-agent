import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type IngestWikiPageInput,
	isWikiEvidenceKind,
	isWikiPageStatus,
	isWikiPageType,
	type WikiIngestRequest,
} from "../../wiki/domain/wiki-types.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, boundedStringArray, grantFromBody, json, readJson } from "./web-http.ts";

function namespaceFrom(url: URL, body?: Record<string, unknown>): string | undefined {
	return typeof body?.namespace === "string" ? body.namespace : (url.searchParams.get("namespace") ?? undefined);
}

function pageIdFromPath(pathname: string): string | undefined {
	const match = /^\/api\/wiki\/pages\/([^/]+)$/.exec(pathname);
	return match ? decodeURIComponent(match[1]) : undefined;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function wikiChange(value: unknown): IngestWikiPageInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "change must be an object");
	const body = value as Record<string, unknown>;
	if (typeof body.title !== "string" || typeof body.type !== "string" || typeof body.markdown !== "string") {
		throw new ApiError(400, "change title, type and markdown are required");
	}
	if (!isWikiPageType(body.type)) throw new ApiError(400, "unsupported Wiki page type");
	const evidence = Array.isArray(body.evidence)
		? body.evidence.map((item) => {
				if (!item || typeof item !== "object" || Array.isArray(item))
					throw new ApiError(400, "evidence must be objects");
				const raw = item as Record<string, unknown>;
				if (typeof raw.id !== "string" || typeof raw.kind !== "string" || !isWikiEvidenceKind(raw.kind)) {
					throw new ApiError(400, "evidence id and supported kind are required");
				}
				return {
					id: raw.id,
					kind: raw.kind,
					...(typeof raw.sourceId === "string" ? { sourceId: raw.sourceId } : {}),
					...(typeof raw.paperId === "string" ? { paperId: raw.paperId } : {}),
					...(typeof raw.version === "string" ? { version: raw.version } : {}),
					locator:
						raw.locator && typeof raw.locator === "object" && !Array.isArray(raw.locator)
							? (raw.locator as Record<string, never>)
							: {},
				};
			})
		: undefined;
	return {
		pageId: typeof body.pageId === "string" ? body.pageId : undefined,
		expectedContentHash: typeof body.expectedContentHash === "string" ? body.expectedContentHash : undefined,
		title: body.title,
		type: body.type,
		markdown: body.markdown,
		aliases: strings(body.aliases),
		tags: strings(body.tags),
		evidence,
		sourceNoteIds: strings(body.sourceNoteIds),
		paperIds: strings(body.paperIds),
	};
}

function wikiIngestRequest(body: Record<string, unknown>): WikiIngestRequest {
	if (typeof body.summary !== "string" || !body.summary.trim()) throw new ApiError(400, "summary is required");
	if (!Array.isArray(body.changes) || body.changes.length === 0)
		throw new ApiError(400, "changes must contain at least one page");
	return {
		summary: body.summary.trim(),
		changes: body.changes.map(wikiChange),
	};
}

function searchOptions(url: URL) {
	const type = url.searchParams.get("type") ?? undefined;
	const status = url.searchParams.get("status") ?? undefined;
	if (type && type !== "all" && !isWikiPageType(type)) throw new ApiError(400, "unsupported Wiki page type");
	if (status && status !== "all" && !isWikiPageStatus(status)) throw new ApiError(400, "unsupported Wiki page status");
	return {
		query: url.searchParams.get("query") ?? undefined,
		pageId: url.searchParams.get("pageId") ?? undefined,
		paperId: url.searchParams.get("paperId") ?? undefined,
		noteId: url.searchParams.get("noteId") ?? undefined,
		type: type as "all" | IngestWikiPageInput["type"] | undefined,
		status: status as "all" | "draft" | "needs-review" | "reviewed" | "conflicted" | undefined,
		limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
		includeRelated: url.searchParams.get("includeRelated") === "true",
	};
}

export async function handleWikiRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/wiki/")) return false;
	const namespace = namespaceFrom(url) ?? application.defaultNamespace;
	if (request.method === "GET" && url.pathname === "/api/wiki/pages") {
		json(response, 200, await application.listWikiPages(namespace, searchOptions(url)));
		return true;
	}
	if (request.method === "GET" && url.pathname === "/api/wiki/management-file") {
		const path = url.searchParams.get("path");
		if (!path) throw new ApiError(400, "Wiki management file path is required");
		const file = await application.getWikiManagementFile(path, namespace);
		if (!file) throw new ApiError(404, `Wiki management file not found: ${path}`);
		json(response, 200, { namespace, file });
		return true;
	}
	const pageId = pageIdFromPath(url.pathname);
	if (request.method === "GET" && pageId) {
		const result = await application.getWikiPage(pageId, namespace);
		if (!result) throw new ApiError(404, `Wiki page not found: ${pageId}`);
		json(response, 200, { namespace, ...result });
		return true;
	}
	if (request.method === "GET" && url.pathname === "/api/wiki/lint") {
		json(response, 200, { namespace, ...(await application.lintWiki(namespace)) });
		return true;
	}
	if (request.method !== "POST") return false;
	const body = await readJson(request);
	const bodyNamespace = namespaceFrom(url, body) ?? application.defaultNamespace;
	if (url.pathname === "/api/wiki/sync") {
		json(response, 200, { namespace: bodyNamespace, ...(await application.lintWiki(bodyNamespace)) });
		return true;
	}
	if (url.pathname === "/api/wiki/open") {
		if (body.action !== "folder" && body.action !== "obsidian")
			throw new ApiError(400, "action must be folder or obsidian");
		json(response, 200, await application.openWiki(body.action, bodyNamespace));
		return true;
	}
	if (url.pathname === "/api/wiki/source-pages/delete/prepare") {
		if (typeof body.paperId !== "string" || !body.paperId.trim() || body.paperId.length > 512) {
			throw new ApiError(400, "paperId is required");
		}
		const includeMixedPageIds = boundedStringArray(body.includeMixedPageIds, "includeMixedPageIds", 100, 128) ?? [];
		json(
			response,
			200,
			await application.prepareWikiSourcePageDeletion(body.paperId, includeMixedPageIds, bodyNamespace),
		);
		return true;
	}
	if (url.pathname === "/api/wiki/source-pages/delete/execute") {
		if (typeof body.paperId !== "string" || !body.paperId.trim() || body.paperId.length > 512) {
			throw new ApiError(400, "paperId is required");
		}
		if (typeof body.previewFingerprint !== "string" || !body.previewFingerprint.trim()) {
			throw new ApiError(400, "previewFingerprint is required");
		}
		const includeMixedPageIds = boundedStringArray(body.includeMixedPageIds, "includeMixedPageIds", 100, 128) ?? [];
		json(
			response,
			200,
			await application.deleteWikiSourcePages(
				body.paperId,
				includeMixedPageIds,
				body.previewFingerprint,
				grantFromBody(body),
				bodyNamespace,
			),
		);
		return true;
	}
	if (url.pathname === "/api/wiki/ingest/prepare") {
		json(response, 200, await application.prepareWikiIngest(wikiIngestRequest(body), bodyNamespace));
		return true;
	}
	if (url.pathname === "/api/wiki/ingest/execute") {
		const requestInput = wikiIngestRequest(body);
		json(response, 200, {
			...(await application.ingestWikiPages(requestInput, grantFromBody(body), bodyNamespace)),
		});
		return true;
	}
	return false;
}
