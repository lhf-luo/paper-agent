import type { IncomingMessage, ServerResponse } from "node:http";
import {
	validateArxivNewsCategories,
	validateArxivNewsDate,
	validateArxivNewsPull,
} from "../../literature/application/arxiv-news.ts";
import { validateNewsFilterGroups } from "../../literature/application/arxiv-news-screening.ts";
import { ARXIV_NEWS_NAMESPACE } from "../../literature/infrastructure/arxiv-news-store.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json, readJson, stringArray } from "./web-http.ts";

export async function handleArxivNewsRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	if (request.method === "GET" && url.pathname === "/api/arxiv-news") {
		json(response, 200, await application.arxivNewsState());
		return;
	}
	if (request.method === "PUT" && url.pathname === "/api/arxiv-news/settings") {
		const body = await readJson(request);
		const categories = stringArray(body.categories);
		if (!categories) throw new ApiError(400, "categories is required");
		try {
			const normalized = categories.length ? validateArxivNewsCategories(categories) : [];
			const nextStartDate =
				body.nextStartDate === undefined
					? undefined
					: typeof body.nextStartDate === "string"
						? validateArxivNewsDate(body.nextStartDate)
						: (() => {
								throw new Error("nextStartDate must be a UTC date");
							})();
			const filterGroups = body.filterGroups === undefined ? undefined : validateNewsFilterGroups(body.filterGroups);
			json(
				response,
				200,
				await application.saveArxivNewsSettings(ARXIV_NEWS_NAMESPACE, normalized, nextStartDate, filterGroups),
			);
		} catch (error) {
			throw new ApiError(400, error instanceof Error ? error.message : String(error));
		}
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/arxiv-news/pulls") {
		const body = await readJson(request);
		const categories = stringArray(body.categories);
		if (!categories || typeof body.startDate !== "string" || typeof body.endDate !== "string") {
			throw new ApiError(400, "categories, startDate, and endDate are required");
		}
		try {
			const input = validateArxivNewsPull({
				namespace: ARXIV_NEWS_NAMESPACE,
				categories,
				startDate: body.startDate,
				endDate: body.endDate,
			});
			json(response, 202, await application.enqueueArxivNewsPull(input));
		} catch (error) {
			throw new ApiError(400, error instanceof Error ? error.message : String(error));
		}
		return;
	}
	const match = /^\/api\/arxiv-news\/batches\/([^/]+)$/.exec(url.pathname);
	if (match) {
		const namespace = ARXIV_NEWS_NAMESPACE;
		const id = decodeURIComponent(match[1]);
		if (request.method === "GET") {
			const batch = await application.arxivNewsBatch(namespace, id);
			if (!batch) throw new ApiError(404, "News folder not found");
			json(response, 200, batch);
			return;
		}
		if (request.method === "DELETE") {
			if (!(await application.deleteArxivNewsBatch(namespace, id))) throw new ApiError(404, "News folder not found");
			json(response, 200, { ok: true });
			return;
		}
	}
	throw new ApiError(404, "News API route not found");
}
