import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaperAgentApplication } from "../../../app/application/paper-agent-application.ts";
import { grantFromBody, json, readJson } from "../../../app/presentation/web-http.ts";
import type { PdfTranslationRequest } from "../domain/pdf-translation-types.ts";

function requestFromBody(body: Record<string, unknown>): Partial<PdfTranslationRequest> {
	return {
		paperId: typeof body.paperId === "string" ? body.paperId : undefined,
		namespace: typeof body.namespace === "string" ? body.namespace : undefined,
		sourceSha256: typeof body.sourceSha256 === "string" ? body.sourceSha256 : undefined,
		sourceLanguage: typeof body.sourceLanguage === "string" ? body.sourceLanguage : undefined,
		targetLanguage: typeof body.targetLanguage === "string" ? body.targetLanguage : undefined,
		outputMode: body.outputMode === "mono" || body.outputMode === "dual" ? body.outputMode : undefined,
	};
}

export async function handlePdfTranslationRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (request.method === "GET" && url.pathname === "/api/pdf-translations/status") {
		json(response, 200, await application.pdfTranslationStatus());
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/pdf-translations/prepare") {
		json(response, 200, await application.preparePdfTranslation(requestFromBody(await readJson(request))));
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/pdf-translations/execute") {
		const body = await readJson(request);
		json(
			response,
			202,
			await application.enqueueAuthorizedPdfTranslation(requestFromBody(body), grantFromBody(body)),
		);
		return true;
	}
	const cancel = /^\/api\/pdf-translations\/([^/]+)$/.exec(url.pathname);
	if (request.method === "DELETE" && cancel) {
		json(response, 200, await application.cancelPdfTranslation(decodeURIComponent(cancel[1])));
		return true;
	}
	return false;
}
