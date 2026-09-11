import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackgroundJobStatus } from "../../shared/domain/background-job.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, json } from "./web-http.ts";

export async function handleJobRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	openStreams: Set<ServerResponse>,
): Promise<void> {
	if (request.method === "GET" && url.pathname === "/api/jobs") {
		const statusValue = url.searchParams.get("status");
		const status =
			statusValue && ["queued", "running", "paused", "succeeded", "failed", "cancelled"].includes(statusValue)
				? (statusValue as BackgroundJobStatus)
				: undefined;
		json(response, 200, { jobs: application.jobs.list({ status: status || undefined, limit: 300 }) });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/jobs/clear") {
		// 一键清空所有终态任务(已完成/失败/已取消), 保留运行中的任务。
		const removed = application.jobs.deleteAll();
		json(response, 200, { ok: true, removed });
		return;
	}
	const jobRoute = /^\/api\/jobs\/([^/]+)(?:\/(cancel|pause|resume|retry))?$/.exec(url.pathname);
	if (jobRoute) {
		const id = decodeURIComponent(jobRoute[1]);
		if (request.method === "DELETE" && !jobRoute[2]) {
			const existing = application.jobs.get(id);
			if (!existing) throw new ApiError(404, "Job not found");
			if (["queued", "running", "paused"].includes(existing.status)) {
				throw new ApiError(409, `Cannot delete a ${existing.status} job; cancel it first`);
			}
			json(response, 200, await application.deleteJob(id));
			return;
		}
		if (request.method === "GET" && !jobRoute[2]) {
			const job = application.jobs.get(id);
			json(response, job ? 200 : 404, job ?? { error: "Job not found" });
			return;
		}
		if (request.method === "POST" && jobRoute[2]) {
			const existing = application.jobs.get(id);
			if (!existing) throw new ApiError(404, "Job not found");
			if (jobRoute[2] === "retry") {
				if (!["literature-search", "pdf-analysis", "artifact-discovery"].includes(existing.type)) {
					throw new ApiError(
						409,
						"This write operation requires a new review and confirmation before it can run again",
					);
				}
				if (!["succeeded", "failed", "cancelled"].includes(existing.status)) {
					throw new ApiError(409, `Cannot retry a ${existing.status} job`);
				}
			}
			const job =
				jobRoute[2] === "retry"
					? await application.retryJob(id)
					: jobRoute[2] === "cancel"
						? await application.jobs.cancel(id)
						: jobRoute[2] === "pause"
							? await application.jobs.pause(id)
							: await application.jobs.resume(id);
			json(response, 200, job);
			return;
		}
	}
	if (request.method === "GET" && url.pathname === "/api/events") {
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
		openStreams.add(response);
		const unsubscribe = application.jobs.subscribe((job) => {
			response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
		});
		const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
		request.once("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
			openStreams.delete(response);
		});
		return;
	}
	throw new ApiError(404, "Job API route not found");
}
