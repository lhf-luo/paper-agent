import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type CapturedPageMetadata,
	CapturedPdfValidationError,
} from "../../literature/application/local-literature-import.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import type { ConnectorCaptureInput } from "../application/paper-agent-connector.ts";
import { ApiError, json, namespaceValue, readJson } from "./web-http.ts";

function connectorHeaders(response: ServerResponse): void {
	response.setHeader("access-control-allow-origin", "*");
	response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
	response.setHeader("access-control-allow-headers", "content-type");
	response.setHeader("access-control-max-age", "600");
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.trim().length > maximum) {
		throw new ApiError(400, `${label} must be a string of at most ${maximum} characters`);
	}
	return value.trim();
}

function pageMetadata(value: unknown): CapturedPageMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "metadata is required");
	const source = value as Record<string, unknown>;
	const authors = source.authors;
	if (
		authors !== undefined &&
		(!Array.isArray(authors) ||
			authors.length > 100 ||
			!authors.every((author) => typeof author === "string" && author.trim().length <= 500))
	) {
		throw new ApiError(400, "metadata.authors must contain at most 100 author names");
	}
	return {
		pageUrl: optionalString(source.pageUrl, "metadata.pageUrl", 32_768),
		pdfUrl: optionalString(source.pdfUrl, "metadata.pdfUrl", 32_768),
		title: optionalString(source.title, "metadata.title", 2_000),
		authors: authors as string[] | undefined,
		doi: optionalString(source.doi, "metadata.doi", 500),
		arxivId: optionalString(source.arxivId, "metadata.arxivId", 200),
	};
}

function captureInput(value: Record<string, unknown>, signal?: AbortSignal): ConnectorCaptureInput {
	return {
		metadata: pageMetadata(value.metadata),
		namespace: namespaceValue(value.namespace),
		collection: optionalString(value.collection, "collection", 500),
		signal,
	};
}

export async function handleConnectorRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/connector/")) return false;
	connectorHeaders(response);
	if (request.method === "OPTIONS") {
		response.writeHead(204).end();
		return true;
	}
	if (request.method === "GET" && url.pathname === "/api/connector/ping") {
		json(response, 200, await application.connectorStatus());
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/connector/capture-path") {
		const value = await readJson(request, 64 * 1024);
		const localPath = optionalString(value.localPath, "localPath", 32_767);
		if (!localPath) throw new ApiError(400, "localPath is required");
		const input = captureInput(value);
		try {
			json(response, 200, await application.capturePdfFromLocalPath(input, localPath));
		} catch (error) {
			if (!(error instanceof CapturedPdfValidationError)) throw error;
			json(response, 422, { error: error.message });
		}
		return true;
	}
	throw new ApiError(404, "Connector route not found");
}
