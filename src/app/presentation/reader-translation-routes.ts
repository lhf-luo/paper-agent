import type { IncomingMessage, ServerResponse } from "node:http";
import { loadPaperAgentConfig } from "../../config/infrastructure/config-repository.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import {
	availableReaderTranslationProviders,
	ReaderTranslationError,
	translateReaderSelection,
} from "../application/reader-translation.ts";
import { ApiError, json, readJson } from "./web-http.ts";

export async function handleReaderTranslationRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname === "/api/reader/translation/providers" && request.method === "GET") {
		const config = await loadPaperAgentConfig(application.projectRoot);
		json(response, 200, {
			providers: availableReaderTranslationProviders(config),
			defaultProvider: config.readerTranslation.defaultProvider,
		});
		return true;
	}
	if (url.pathname !== "/api/reader/translate" || request.method !== "POST") return false;
	const body = await readJson(request, 30_000);
	if (typeof body.text !== "string" || !body.text.trim() || Array.from(body.text.trim()).length > 5_000)
		throw new ApiError(400, "选中文字须为 1–5000 个字符");
	if (
		body.provider !== "google" &&
		body.provider !== "deepl" &&
		body.provider !== "youdao" &&
		body.provider !== "baidu"
	)
		throw new ApiError(400, "不支持的翻译服务");
	if (body.targetLanguage !== "zh-CN" && body.targetLanguage !== "en") throw new ApiError(400, "不支持的目标语言");
	const config = await loadPaperAgentConfig(application.projectRoot);
	const controller = new AbortController();
	const onClose = () => {
		if (!response.writableEnded) controller.abort();
	};
	response.on("close", onClose);
	try {
		json(
			response,
			200,
			await translateReaderSelection({
				text: body.text,
				provider: body.provider,
				targetLanguage: body.targetLanguage,
				config,
				signal: controller.signal,
			}),
		);
	} catch (error) {
		if (error instanceof ReaderTranslationError)
			throw new ApiError(error.status === 499 ? 408 : error.status, error.message);
		throw error;
	} finally {
		response.off("close", onClose);
	}
	return true;
}
