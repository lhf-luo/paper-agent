import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
	ArtifactReviewNotFoundError,
	type ArtifactReviewSubmissionInput,
} from "./artifact-evaluation-review.ts";
import type { BackgroundJobStatus } from "./job-queue.ts";
import type { ScreeningStatus, SearchFilters } from "./literature-types.ts";
import type { ConfirmationGrant } from "./operation-consent.ts";
import type {
	ArtifactAcquisitionPreparationInput,
	LiteratureSearchJobInput,
	PaperAgentApplication,
	PersonalCorpusAnnotationInput,
	PersonalCorpusExportInput,
	PdfAssetCorrectionInput,
	PdfDownloadPreparationInput,
	TeamArtifactProposalInput,
	TeamBlobUploadInput,
	TeamReviewInput,
	TeamRestoreDrillInput,
	TeamTokenChangeInput,
} from "./paper-agent-application.ts";
import type { ResearchRecord, ResearchRecordKind } from "./research-workspace.ts";
import {
	WebAgentServiceError,
	type WebAgentConfigUpdate,
	type WebAgentEvent,
	type WebAgentMode,
	type WebAgentServiceApi,
} from "./web-agent-service.ts";

export interface LocalWebServerOptions {
	host?: string;
	port?: number;
	staticRoot: string;
	sessionToken: string;
	agentService?: WebAgentServiceApi;
}

export interface LocalWebServerHandle {
	url: string;
	host: string;
	port: number;
	close(): Promise<void>;
}

class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

async function readJson(request: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new ApiError(413, "Request body exceeds the configured limit");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
		return parsed as Record<string, unknown>;
	} catch {
		throw new ApiError(400, "Request body must contain a JSON object");
	}
}

function authorized(request: IncomingMessage, token: string): boolean {
	const authorization = request.headers.authorization;
	return authorization === `Bearer ${token}` || request.headers["x-paper-agent-token"] === token;
}

function numberValue(value: unknown, fallback?: number): number | undefined {
	if (value === undefined || value === null || value === "") return fallback;
	const number = Number(value);
	if (!Number.isFinite(number)) throw new ApiError(400, "Expected a finite number");
	return number;
}

function stringArray(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new ApiError(400, "Expected an array of strings");
	}
	return value;
}

function boundedStringArray(value: unknown, label: string, maxItems = 100, maxLength = 500): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > maxItems ||
		!value.every((item) => typeof item === "string" && item.trim().length > 0 && item.trim().length <= maxLength)
	) {
		throw new ApiError(400, `${label} must contain at most ${maxItems} non-empty strings`);
	}
	return [...new Set(value.map((item) => item.trim()))];
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new ApiError(400, `${label} must be an integer between ${minimum} and ${maximum}`);
	}
	return parsed;
}

function namespaceValue(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
		throw new ApiError(400, "namespace must be a safe 1-64 character identifier");
	}
	return value;
}

function screeningStatusValue(value: unknown): ScreeningStatus | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (!["unreviewed", "include", "exclude", "maybe"].includes(String(value))) {
		throw new ApiError(400, "screeningStatus must be unreviewed, include, exclude, or maybe");
	}
	return value as ScreeningStatus;
}

function searchFilters(value: unknown): SearchFilters {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ApiError(400, "filters must be a JSON object");
	}
	const source = value as Record<string, unknown>;
	const allowed = new Set(["yearFrom", "yearTo", "venues", "authors", "openAccess", "types"]);
	const unknown = Object.keys(source).filter((key) => !allowed.has(key));
	if (unknown.length) throw new ApiError(400, `Unsupported search filter(s): ${unknown.join(", ")}`);
	const yearFrom = integerValue(source.yearFrom, "filters.yearFrom", 1000, 9999);
	const yearTo = integerValue(source.yearTo, "filters.yearTo", 1000, 9999);
	if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
		throw new ApiError(400, "filters.yearFrom cannot be later than filters.yearTo");
	}
	if (source.openAccess !== undefined && typeof source.openAccess !== "boolean") {
		throw new ApiError(400, "filters.openAccess must be a boolean");
	}
	return {
		yearFrom,
		yearTo,
		venues: boundedStringArray(source.venues, "filters.venues", 100, 500),
		authors: boundedStringArray(source.authors, "filters.authors", 100, 500),
		openAccess: source.openAccess as boolean | undefined,
		types: boundedStringArray(source.types, "filters.types", 100, 200),
	};
}

function grantFromBody(body: Record<string, unknown>): ConfirmationGrant {
	const grant = body.grant;
	if (!grant || typeof grant !== "object" || Array.isArray(grant)) throw new ApiError(400, "grant is required");
	const value = grant as Record<string, unknown>;
	for (const key of ["operationId", "manifestFingerprint", "confirmationToken", "expiresAt"] as const) {
		if (typeof value[key] !== "string") throw new ApiError(400, `grant.${key} is required`);
	}
	return value as unknown as ConfirmationGrant;
}

const mimeTypes: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};

async function serveStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<void> {
	const root = resolve(staticRoot);
	const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
	let path = resolve(root, requested);
	const pathRelative = relative(root, path);
	if (pathRelative.startsWith("..") || isAbsolute(pathRelative)) throw new ApiError(404, "Not found");
	try {
		const fileStat = await stat(path);
		if (fileStat.isDirectory()) path = join(path, "index.html");
	} catch {
		path = join(root, "index.html");
	}
	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(path);
	} catch {
		throw new ApiError(503, "Web assets are not built. Run npm run web:build.");
	}
	response.writeHead(200, {
		"content-type": mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
		"content-length": fileStat.size,
		"cache-control": path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
		"content-security-policy":
			"default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'self'",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
	});
	createReadStream(path).pipe(response);
}

export async function startLocalWebServer(
	application: PaperAgentApplication,
	options: LocalWebServerOptions,
): Promise<LocalWebServerHandle> {
	await application.initialize();
	const host = options.host ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
		throw new Error("The local Paper Agent server may only listen on loopback addresses");
	}
	const openStreams = new Set<ServerResponse>();
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://paper-agent.local");
			if (request.method === "GET" && url.pathname === "/health") {
				json(response, 200, { ok: true, service: "paper-agent-local", version: 1 });
				return;
			}
			if (!url.pathname.startsWith("/api/")) {
				await serveStatic(response, options.staticRoot, url.pathname);
				return;
			}
			if (!authorized(request, options.sessionToken))
				throw new ApiError(401, "Local session authorization required");
			if (url.pathname.startsWith("/api/agent/")) {
				const agentService = options.agentService;
				if (!agentService) throw new ApiError(503, "Web Agent service is unavailable");
				if (request.method === "GET" && url.pathname === "/api/agent/config") {
					json(response, 200, await agentService.getConfig());
					return;
				}
				if (request.method === "PUT" && url.pathname === "/api/agent/config") {
					json(response, 200, await agentService.updateConfig((await readJson(request)) as unknown as WebAgentConfigUpdate));
					return;
				}
				if (request.method === "DELETE" && url.pathname === "/api/agent/key") {
					json(response, 200, await agentService.clearKey());
					return;
				}
				if (request.method === "GET" && url.pathname === "/api/agent/sessions") {
					json(response, 200, { sessions: await agentService.listSessions() });
					return;
				}
				if (request.method === "POST" && url.pathname === "/api/agent/sessions") {
					const body = await readJson(request);
					json(
						response,
						201,
						await agentService.createSession({
							mode: body.mode as WebAgentMode,
							title: typeof body.title === "string" ? body.title : undefined,
						}),
					);
					return;
				}
				const agentEventRoute = /^\/api\/agent\/sessions\/([^/]+)\/events$/.exec(url.pathname);
				if (request.method === "GET" && agentEventRoute) {
					const id = decodeURIComponent(agentEventRoute[1]);
					let writeEvent = (_event: string, _value: unknown, _eventId?: number) => undefined;
					const subscription = agentService.subscribeSession(id, (event: WebAgentEvent) =>
						writeEvent(event.type, event, event.id),
					);
					response.writeHead(200, {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-store",
						connection: "keep-alive",
						"x-accel-buffering": "no",
					});
					openStreams.add(response);
					writeEvent = (event: string, value: unknown, eventId?: number) => {
						if (eventId !== undefined) response.write(`id: ${eventId}\n`);
						response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
					};
					writeEvent("snapshot", subscription.snapshot);
					const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
					request.once("close", () => {
						clearInterval(heartbeat);
						subscription.unsubscribe();
						openStreams.delete(response);
					});
					return;
				}
				const agentUIRoute = /^\/api\/agent\/sessions\/([^/]+)\/ui\/([^/]+)\/respond$/.exec(url.pathname);
				if (request.method === "POST" && agentUIRoute) {
					const body = await readJson(request);
					json(
						response,
						200,
						await agentService.respondToUI(
							decodeURIComponent(agentUIRoute[1]),
							decodeURIComponent(agentUIRoute[2]),
							body.value,
						),
					);
					return;
				}
				const agentActionRoute = /^\/api\/agent\/sessions\/([^/]+)\/(messages|abort)$/.exec(url.pathname);
				if (request.method === "POST" && agentActionRoute) {
					const id = decodeURIComponent(agentActionRoute[1]);
					if (agentActionRoute[2] === "abort") {
						json(response, 200, await agentService.abortSession(id));
					} else {
						const body = await readJson(request);
						json(
							response,
							202,
							await agentService.sendMessage(id, { message: typeof body.message === "string" ? body.message : "" }),
						);
					}
					return;
				}
				const agentSessionRoute = /^\/api\/agent\/sessions\/([^/]+)$/.exec(url.pathname);
				if (agentSessionRoute) {
					const id = decodeURIComponent(agentSessionRoute[1]);
					if (request.method === "GET") {
						json(response, 200, await agentService.getSession(id));
						return;
					}
					if (request.method === "DELETE") {
						await agentService.deleteSession(id);
						json(response, 200, { ok: true });
						return;
					}
				}
				throw new ApiError(404, "Agent API route not found");
			}
			if (request.method === "GET" && url.pathname === "/api/status") {
				json(response, 200, await application.status());
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/config") {
				json(response, 200, await application.configuration());
				return;
			}
				if (request.method === "GET" && url.pathname === "/api/providers") {
					json(response, 200, { providers: application.providerCatalog() });
					return;
				}
					if (request.method === "GET" && url.pathname === "/api/namespaces") {
					const [status, config] = await Promise.all([application.status(), application.configuration()]);
					json(response, 200, {
						defaultNamespace: status.defaultNamespace,
						personal: [...new Set([status.defaultNamespace, ...status.personalNamespaces])],
						team: config.team ? [config.team.namespace] : [],
					});
						return;
					}
					if (request.method === "GET" && url.pathname === "/api/evaluation/artifacts") {
						json(response, 200, await application.artifactEvaluationQueue());
						return;
					}
					const evaluationRoute = /^\/api\/evaluation\/artifacts\/([^/]+)(?:\/(pdf|prepare|execute))?$/.exec(
						url.pathname,
					);
					if (evaluationRoute) {
						const slug = decodeURIComponent(evaluationRoute[1]);
						const action = evaluationRoute[2];
						if (request.method === "GET" && !action) {
							json(response, 200, await application.artifactEvaluationDetails(slug));
							return;
						}
						if (request.method === "GET" && action === "pdf") {
							const pdf = await application.readArtifactEvaluationPdf(slug);
							response.writeHead(200, {
								"content-type": "application/pdf",
								"content-length": pdf.body.length,
								"content-disposition": `inline; filename="${encodeURIComponent(pdf.filename)}"`,
								"cache-control": "private, no-store",
								"x-content-type-options": "nosniff",
							});
							response.end(pdf.body);
							return;
						}
						if (request.method === "POST" && (action === "prepare" || action === "execute")) {
							const body = await readJson(request);
							if (!body.submission || typeof body.submission !== "object" || Array.isArray(body.submission)) {
								throw new ApiError(400, "submission is required");
							}
							const submission = body.submission as unknown as ArtifactReviewSubmissionInput;
							json(
								response,
								200,
								action === "prepare"
									? await application.prepareArtifactEvaluationReview(slug, submission)
									: await application.saveArtifactEvaluationReview(slug, submission, grantFromBody(body)),
							);
							return;
						}
					}
				if (request.method === "GET" && url.pathname === "/api/jobs") {
				const statusValue = url.searchParams.get("status");
				const status =
					statusValue && ["queued", "running", "paused", "succeeded", "failed", "cancelled"].includes(statusValue)
						? (statusValue as BackgroundJobStatus)
						: undefined;
				json(response, 200, { jobs: application.jobs.list({ status: status || undefined, limit: 300 }) });
				return;
			}
			const jobRoute = /^\/api\/jobs\/([^/]+)(?:\/(cancel|pause|resume|retry))?$/.exec(url.pathname);
			if (jobRoute) {
				const id = decodeURIComponent(jobRoute[1]);
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
				if (request.method === "POST" && url.pathname === "/api/search") {
					const body = await readJson(request);
					if (typeof body.query !== "string" || !body.query.trim() || body.query.trim().length > 2_000)
						throw new ApiError(400, "query must contain 1-2000 characters");
					const providers = boundedStringArray(body.providers, "providers", 20, 64);
					if (providers?.length === 0) throw new ApiError(400, "Select at least one literature provider");
					const supportedProviders = new Set<string>(application.providerCatalog().map((provider) => provider.id));
					const unsupportedProviders = (providers ?? []).filter((provider) => !supportedProviders.has(provider));
					if (unsupportedProviders.length) {
						throw new ApiError(400, `Unsupported literature provider(s): ${unsupportedProviders.join(", ")}`);
					}
					if (body.reuseCorpus !== undefined && typeof body.reuseCorpus !== "boolean") {
						throw new ApiError(400, "reuseCorpus must be a boolean");
					}
					const input: LiteratureSearchJobInput = {
						query: body.query.trim(),
						queryExpansions: boundedStringArray(body.queryExpansions, "queryExpansions", 20, 500),
						providers: providers as LiteratureSearchJobInput["providers"],
						filters: searchFilters(body.filters),
						pagesPerProvider: integerValue(body.pagesPerProvider, "pagesPerProvider", 1, 20),
						maxResultsPerProvider: integerValue(body.maxResultsPerProvider, "maxResultsPerProvider", 1, 500),
						namespace: namespaceValue(body.namespace),
						reuseCorpus: typeof body.reuseCorpus === "boolean" ? body.reuseCorpus : undefined,
					};
				json(response, 202, await application.enqueueLiteratureSearch(input));
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/library") {
				json(
					response,
					200,
					await application.searchPersonalLibrary({
						query: url.searchParams.get("q") ?? undefined,
						namespace: url.searchParams.get("namespace") ?? undefined,
						yearFrom: numberValue(url.searchParams.get("yearFrom")),
						yearTo: numberValue(url.searchParams.get("yearTo")),
							tags: url.searchParams.getAll("tag"),
							screeningStatuses: url.searchParams
								.getAll("screeningStatus")
								.map((value) => screeningStatusValue(value) as ScreeningStatus),
							limit: numberValue(url.searchParams.get("limit"), 100),
					}),
				);
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/local-pdf") {
				const path = url.searchParams.get("path");
				if (!path) throw new ApiError(400, "path is required");
				const pdf = await application.readLocalPdf(path);
				response.writeHead(200, {
					"content-type": "application/pdf",
					"content-length": pdf.body.length,
					"content-disposition": `inline; filename="${encodeURIComponent(pdf.path.split(/[\\/]/).at(-1) ?? "paper.pdf")}"`,
					"cache-control": "private, no-store",
					"x-content-type-options": "nosniff",
				});
				response.end(pdf.body);
				return;
			}
			const paperRoute = /^\/api\/papers\/([^/]+)$/.exec(url.pathname);
			if (request.method === "GET" && paperRoute) {
				const details = await application.paperDetails(
					decodeURIComponent(paperRoute[1]),
					url.searchParams.get("namespace") ?? undefined,
				);
				json(response, details ? 200 : 404, details ?? { error: "Paper not found" });
				return;
			}
			const pdfBlobRoute = /^\/api\/papers\/([^/]+)\/pdf\/([a-f0-9]{64})$/.exec(url.pathname);
			if (request.method === "GET" && pdfBlobRoute) {
				const body = await application.readPdfVersionBlob(
					decodeURIComponent(pdfBlobRoute[1]),
					pdfBlobRoute[2],
					url.searchParams.get("namespace") ?? undefined,
				);
				response.writeHead(200, {
					"content-type": "application/pdf",
					"content-length": body.length,
					"cache-control": "private, no-store",
					"x-content-type-options": "nosniff",
				});
				response.end(body);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/pdf/analyze") {
				const body = await readJson(request);
				if (typeof body.pdfPath !== "string") throw new ApiError(400, "pdfPath is required");
				json(
					response,
					202,
					await application.enqueuePdfAnalysis({
						pdfPath: body.pdfPath,
						refine: typeof body.refine === "boolean" ? body.refine : undefined,
						ocr: typeof body.ocr === "boolean" ? body.ocr : undefined,
					}),
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/artifacts/discover") {
				const body = await readJson(request);
				if (typeof body.pdfPath !== "string") throw new ApiError(400, "pdfPath is required");
				json(response, 202, await application.enqueueArtifactDiscovery({ pdfPath: body.pdfPath }));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/pdf-downloads/prepare") {
				const body = await readJson(request);
				const input: PdfDownloadPreparationInput = {
					paperIds: stringArray(body.paperIds),
					maxFiles: numberValue(body.maxFiles),
					maxMegabytesPerFile: numberValue(body.maxMegabytesPerFile),
					concurrency: numberValue(body.concurrency),
					namespace: typeof body.namespace === "string" ? body.namespace : undefined,
				};
				json(response, 200, await application.preparePdfDownload(input));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/library/import/prepare") {
				const body = await readJson(request);
				if (typeof body.searchJobId !== "string") throw new ApiError(400, "searchJobId is required");
				json(
					response,
					200,
					await application.prepareCorpusImport({
						searchJobId: body.searchJobId,
						paperIds: stringArray(body.paperIds),
						namespace: typeof body.namespace === "string" ? body.namespace : undefined,
					}),
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/artifacts/prepare") {
				const body = await readJson(request);
				if (typeof body.pdfPath !== "string") throw new ApiError(400, "pdfPath is required");
				const input: ArtifactAcquisitionPreparationInput = {
					pdfPath: body.pdfPath,
					candidateIds: stringArray(body.candidateIds),
					maxArtifacts: numberValue(body.maxArtifacts),
					maxMegabytesPerArtifact: numberValue(body.maxMegabytesPerArtifact),
				};
				json(response, 200, await application.prepareArtifactAcquisition(input));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/operations/confirm") {
				const body = await readJson(request);
				if (typeof body.operationId !== "string" || typeof body.manifestFingerprint !== "string") {
					throw new ApiError(400, "operationId and manifestFingerprint are required");
				}
				json(response, 200, await application.confirmOperation(body.operationId, body.manifestFingerprint));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/config/prepare") {
				const body = await readJson(request);
				json(response, 200, await application.prepareConfigurationWrite(body.config));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/config/execute") {
				const body = await readJson(request);
				json(response, 200, await application.writeConfiguration(body.config, grantFromBody(body)));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/model-probe/prepare") {
				json(response, 200, await application.prepareModelProbe());
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/model-probe/execute") {
				const body = await readJson(request);
				json(response, 200, await application.runModelProbe(grantFromBody(body)));
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/team/overview") {
				json(response, 200, await application.teamOverview());
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/team/search") {
				json(
					response,
					200,
					await application.searchTeamLibrary({
						query: url.searchParams.get("q") ?? undefined,
						yearFrom: numberValue(url.searchParams.get("yearFrom")),
						yearTo: numberValue(url.searchParams.get("yearTo")),
						limit: numberValue(url.searchParams.get("limit"), 100),
						cursor: url.searchParams.get("cursor") ?? undefined,
					}),
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/team/proposals/prepare") {
				const body = await readJson(request);
				json(
					response,
					200,
					await application.prepareTeamPaperProposal({
						paperIds: stringArray(body.paperIds) ?? [],
						personalNamespace: typeof body.personalNamespace === "string" ? body.personalNamespace : undefined,
					}),
				);
				return;
			}
				if (request.method === "POST" && url.pathname === "/api/team/proposals/execute") {
				const body = await readJson(request);
				json(
					response,
					200,
					await application.proposeTeamPapers(
						{
							paperIds: stringArray(body.paperIds) ?? [],
							personalNamespace: typeof body.personalNamespace === "string" ? body.personalNamespace : undefined,
						},
						grantFromBody(body),
					),
				);
					return;
				}
				if (
					request.method === "POST" &&
					(url.pathname === "/api/library/annotations/prepare" ||
						url.pathname === "/api/library/annotations/execute")
				) {
					const body = await readJson(request);
					const input: PersonalCorpusAnnotationInput = {
						paperIds: boundedStringArray(body.paperIds, "paperIds", 500, 500) ?? [],
						namespace: namespaceValue(body.namespace),
						author: typeof body.author === "string" ? body.author : undefined,
						tags: boundedStringArray(body.tags, "tags", 50, 100),
						note: typeof body.note === "string" ? body.note : undefined,
						screeningStatus: screeningStatusValue(body.screeningStatus),
						screeningReason: typeof body.screeningReason === "string" ? body.screeningReason : undefined,
					};
					json(
						response,
						200,
						url.pathname.endsWith("/prepare")
							? await application.preparePersonalAnnotation(input)
							: await application.annotatePersonalPapers(input, grantFromBody(body)),
					);
					return;
				}
				if (
					request.method === "POST" &&
					(url.pathname === "/api/library/export/prepare" || url.pathname === "/api/library/export/execute")
				) {
					const body = await readJson(request);
					if (!["markdown", "csv", "bibtex", "json"].includes(String(body.format))) {
						throw new ApiError(400, "format must be markdown, csv, bibtex, or json");
					}
					const input: PersonalCorpusExportInput = {
						format: body.format as PersonalCorpusExportInput["format"],
						namespace: namespaceValue(body.namespace),
						paperIds: boundedStringArray(body.paperIds, "paperIds", 1000, 500),
						filename: typeof body.filename === "string" ? body.filename : undefined,
					};
					json(
						response,
						200,
						url.pathname.endsWith("/prepare")
							? await application.preparePersonalExport(input)
							: await application.exportPersonalCorpus(input, grantFromBody(body)),
					);
					return;
				}
				const personalExportRoute = /^\/api\/library\/exports\/([^/]+)$/.exec(url.pathname);
				if (request.method === "GET" && personalExportRoute) {
					const filename = decodeURIComponent(personalExportRoute[1]);
					const body = await application.readPersonalExport(
						filename,
						url.searchParams.get("namespace") ?? undefined,
					);
					const extension = extname(filename).toLowerCase();
					response.writeHead(200, {
						"content-type":
							extension === ".json"
								? "application/json; charset=utf-8"
								: extension === ".csv"
									? "text/csv; charset=utf-8"
									: "text/plain; charset=utf-8",
						"content-length": body.length,
						"content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
						"cache-control": "private, no-store",
						"x-content-type-options": "nosniff",
					});
					response.end(body);
					return;
				}
				if (
					request.method === "POST" &&
					(url.pathname === "/api/team/artifacts/prepare" || url.pathname === "/api/team/artifacts/execute")
				) {
					const body = await readJson(request);
					if (typeof body.artifactJobId !== "string" || typeof body.paperId !== "string") {
						throw new ApiError(400, "artifactJobId and paperId are required");
					}
					const input: TeamArtifactProposalInput = {
						artifactJobId: body.artifactJobId,
						paperId: body.paperId,
						personalNamespace: namespaceValue(body.personalNamespace),
					};
					json(
						response,
						200,
						url.pathname.endsWith("/prepare")
							? await application.prepareTeamArtifactProposal(input)
							: await application.proposeTeamArtifact(input, grantFromBody(body)),
					);
					return;
				}
				if (
					request.method === "POST" &&
					(url.pathname === "/api/team/blobs/prepare" || url.pathname === "/api/team/blobs/execute")
				) {
					const body = await readJson(request);
					if (typeof body.paperId !== "string" || typeof body.sha256 !== "string") {
						throw new ApiError(400, "paperId and sha256 are required");
					}
					const input: TeamBlobUploadInput = {
						paperId: body.paperId,
						sha256: body.sha256,
						personalNamespace: namespaceValue(body.personalNamespace),
					};
					json(
						response,
						200,
						url.pathname.endsWith("/prepare")
							? await application.prepareTeamBlobUpload(input)
							: await application.uploadTeamBlob(input, grantFromBody(body)),
					);
					return;
				}
			if (
				request.method === "POST" &&
				(url.pathname === "/api/team/reviews/prepare" || url.pathname === "/api/team/reviews/execute")
			) {
				const body = await readJson(request);
				if (!["papers", "derived", "artifacts"].includes(String(body.resource)))
					throw new ApiError(400, "resource must be papers, derived, or artifacts");
				if (body.decision !== "team-approved" && body.decision !== "team-rejected")
					throw new ApiError(400, "decision must be team-approved or team-rejected");
				const input: TeamReviewInput = {
					resource: body.resource as TeamReviewInput["resource"],
					ids: stringArray(body.ids) ?? [],
					decision: body.decision,
					reason: typeof body.reason === "string" ? body.reason : undefined,
				};
				json(
					response,
					200,
					url.pathname.endsWith("/prepare")
						? await application.prepareTeamReview(input)
						: await application.reviewTeamEntries(input, grantFromBody(body)),
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/team/backup/prepare") {
				json(response, 200, await application.prepareTeamBackup());
				return;
			}
				if (request.method === "POST" && url.pathname === "/api/team/backup/execute") {
					json(response, 200, await application.backupTeam(grantFromBody(await readJson(request))));
					return;
				}
				if (
					request.method === "POST" &&
					(url.pathname === "/api/team/restore-drill/prepare" || url.pathname === "/api/team/restore-drill/execute")
				) {
					const body = await readJson(request);
					if (typeof body.backupPath !== "string") throw new ApiError(400, "backupPath is required");
					const input: TeamRestoreDrillInput = { backupPath: body.backupPath };
					json(
						response,
						200,
						url.pathname.endsWith("/prepare")
							? await application.prepareTeamRestoreDrill(input)
							: await application.drillTeamRestore(input, grantFromBody(body)),
					);
					return;
				}
			if (
				request.method === "POST" &&
				(url.pathname === "/api/team/tokens/prepare" || url.pathname === "/api/team/tokens/execute")
			) {
				const body = await readJson(request);
				if (body.action !== "rotate" && body.action !== "revoke")
					throw new ApiError(400, "action must be rotate or revoke");
				if (typeof body.name !== "string") throw new ApiError(400, "name is required");
				const input: TeamTokenChangeInput = {
					action: body.action,
					name: body.name,
					roles: stringArray(body.roles) as TeamTokenChangeInput["roles"],
				};
				json(
					response,
					200,
					url.pathname.endsWith("/prepare")
						? await application.prepareTeamTokenChange(input)
						: await application.changeTeamToken(input, grantFromBody(body)),
				);
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/research") {
				json(response, 200, await application.researchOverview(url.searchParams.get("namespace") ?? undefined));
				return;
			}
			if (
				request.method === "POST" &&
				(url.pathname === "/api/research/write/prepare" || url.pathname === "/api/research/write/execute")
			) {
				const body = await readJson(request);
				if (!body.record || typeof body.record !== "object" || Array.isArray(body.record))
					throw new ApiError(400, "record is required");
				const namespace = typeof body.namespace === "string" ? body.namespace : undefined;
				json(
					response,
					200,
					url.pathname.endsWith("/prepare")
						? await application.prepareResearchWrite(body.record as unknown as ResearchRecord, namespace)
						: await application.writeResearchRecord(
								body.record as unknown as ResearchRecord,
								grantFromBody(body),
								namespace,
							),
				);
				return;
			}
			if (
				request.method === "POST" &&
				(url.pathname === "/api/research/share/prepare" || url.pathname === "/api/research/share/execute")
			) {
				const body = await readJson(request);
				if (
					!["skim-card", "comparison-matrix", "evidence-graph"].includes(String(body.kind)) ||
					typeof body.id !== "string"
				)
					throw new ApiError(400, "kind and id are required");
				const namespace = typeof body.namespace === "string" ? body.namespace : undefined;
				json(
					response,
					200,
					url.pathname.endsWith("/prepare")
						? await application.prepareResearchShare(body.kind as ResearchRecordKind, body.id, namespace)
						: await application.shareResearchRecord(
								body.kind as ResearchRecordKind,
								body.id,
								grantFromBody(body),
								namespace,
							),
				);
				return;
			}
			const artifactJobRoute = /^\/api\/artifacts\/jobs\/([^/]+)$/.exec(url.pathname);
			if (request.method === "GET" && artifactJobRoute) {
				json(response, 200, await application.artifactJobDetails(decodeURIComponent(artifactJobRoute[1])));
				return;
			}
			if (
				request.method === "POST" &&
				(url.pathname === "/api/pdf/corrections/prepare" || url.pathname === "/api/pdf/corrections/execute")
			) {
				const body = await readJson(request);
				if (
					typeof body.analysisJobId !== "string" ||
					typeof body.assetId !== "string" ||
					!body.correctedRegion ||
					typeof body.correctedRegion !== "object" ||
					Array.isArray(body.correctedRegion)
				)
					throw new ApiError(400, "analysisJobId, assetId, and correctedRegion are required");
				const input: PdfAssetCorrectionInput = {
					analysisJobId: body.analysisJobId,
					assetId: body.assetId,
					correctedRegion: body.correctedRegion as unknown as PdfAssetCorrectionInput["correctedRegion"],
					note: typeof body.note === "string" ? body.note : undefined,
					author: typeof body.author === "string" ? body.author : undefined,
				};
				json(
					response,
					200,
					url.pathname.endsWith("/prepare")
						? await application.preparePdfAssetCorrection(input)
						: await application.savePdfAssetCorrection(input, grantFromBody(body)),
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/pdf-downloads/execute") {
				const body = await readJson(request);
				const input: PdfDownloadPreparationInput = {
					paperIds: stringArray(body.paperIds),
					maxFiles: numberValue(body.maxFiles),
					maxMegabytesPerFile: numberValue(body.maxMegabytesPerFile),
					concurrency: numberValue(body.concurrency),
					namespace: typeof body.namespace === "string" ? body.namespace : undefined,
				};
				json(response, 202, await application.enqueueAuthorizedPdfDownload(input, grantFromBody(body)));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/library/import/execute") {
				const body = await readJson(request);
				if (typeof body.searchJobId !== "string") throw new ApiError(400, "searchJobId is required");
				json(
					response,
					202,
					await application.enqueueAuthorizedCorpusImport(
						{
							searchJobId: body.searchJobId,
							paperIds: stringArray(body.paperIds),
							namespace: typeof body.namespace === "string" ? body.namespace : undefined,
						},
						grantFromBody(body),
					),
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/artifacts/execute") {
				const body = await readJson(request);
				if (typeof body.pdfPath !== "string") throw new ApiError(400, "pdfPath is required");
				const input: ArtifactAcquisitionPreparationInput = {
					pdfPath: body.pdfPath,
					candidateIds: stringArray(body.candidateIds),
					maxArtifacts: numberValue(body.maxArtifacts),
					maxMegabytesPerArtifact: numberValue(body.maxMegabytesPerArtifact),
				};
				json(response, 202, await application.enqueueAuthorizedArtifactAcquisition(input, grantFromBody(body)));
				return;
			}
			throw new ApiError(404, "Not found");
		} catch (error) {
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : undefined);
				return;
			}
				if (error instanceof WebAgentServiceError) {
					json(response, error.status, { error: error.message });
					return;
				}
				if (error instanceof ArtifactReviewNotFoundError) {
					json(response, 404, { error: error.message });
					return;
				}
				if (error instanceof ApiError) {
				json(response, error.status, { error: error.message });
				return;
			}
			json(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(options.port ?? 0, host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address() as AddressInfo;
	let closePromise: Promise<void> | undefined;
	return {
		url: `http://${host}:${address.port}`,
		host,
		port: address.port,
		close: () => {
			closePromise ??= (async () => {
				await options.agentService?.close();
				for (const stream of openStreams) stream.end();
				openStreams.clear();
				await new Promise<void>((resolveClose, rejectClose) => {
					server.close((error) => (error ? rejectClose(error) : resolveClose()));
				});
			})();
			return closePromise;
		},
	};
}
