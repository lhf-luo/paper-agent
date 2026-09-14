import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { type WebAgentServiceApi, WebAgentServiceError } from "../../agent/application/web-agent-service.ts";
import { handleMineruRoutes } from "../../extensions/mineru/presentation/mineru-routes.ts";
import { handlePdfTranslationRoutes } from "../../extensions/pdf-translation/presentation/pdf-translation-routes.ts";
import { handleZoteroRoutes } from "../../extensions/zotero/presentation/zotero-routes.ts";
import type {
	ArtifactAcquisitionPreparationInput,
	PaperAgentApplication,
	PdfAssetCorrectionInput,
	PdfDownloadPreparationInput,
} from "../application/paper-agent-application.ts";
import { handleAgentRoutes } from "./agent-routes.ts";
import { handleConnectorRoutes } from "./connector-routes.ts";
import { handleJobRoutes } from "./job-routes.ts";
import { handleLibraryRoutes } from "./library-routes.ts";
import { handleResearchRoutes } from "./research-routes.ts";
import { handleSearchRoutes } from "./search-routes.ts";
import { handleTeamRoutes } from "./team-routes.ts";
import { handleWikiRoutes } from "./wiki-routes.ts";
import { ApiError, grantFromBody, json, numberValue, readJson, stringArray } from "./web-http.ts";

export interface LocalWebServerOptions {
	host?: string;
	port?: number;
	staticRoot: string;
	agentService?: WebAgentServiceApi;
}

export interface LocalWebServerHandle {
	url: string;
	host: string;
	port: number;
	close(): Promise<void>;
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
				"default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'self'",
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
			if (await handleConnectorRoutes(application, request, response, url)) return;
			if (await handleZoteroRoutes(application, request, response, url)) return;
			if (await handlePdfTranslationRoutes(application, request, response, url)) return;
			if (await handleMineruRoutes(application, request, response, url)) return;
			if (await handleWikiRoutes(application, request, response, url)) return;
			if (url.pathname.startsWith("/api/agent/")) {
				await handleAgentRoutes({ request, response, url, agentService: options.agentService, openStreams });
				return;
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
				const [status, teamAccess] = await Promise.all([application.status(), application.teamAccess.status()]);
				const teamNamespaces =
					teamAccess.connected && "identity" in teamAccess
						? [...new Set([teamAccess.namespace, ...teamAccess.identity.namespaces].filter(Boolean))]
						: [];
				json(response, 200, {
					defaultNamespace: status.defaultNamespace,
					personal: [...new Set([status.defaultNamespace, ...status.personalNamespaces])],
					team: teamNamespaces,
				});
				return;
			}
			if (url.pathname.startsWith("/api/jobs") || url.pathname === "/api/events") {
				await handleJobRoutes(application, request, response, url, openStreams);
				return;
			}
			if (url.pathname.startsWith("/api/search")) {
				await handleSearchRoutes(application, request, response, url);
				return;
			}
			if (
				url.pathname.startsWith("/api/library") ||
				url.pathname.startsWith("/api/papers/") ||
				url.pathname === "/api/local-pdf"
			) {
				await handleLibraryRoutes(application, request, response, url);
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
				json(
					response,
					202,
					await application.enqueueArtifactDiscovery({
						pdfPath: body.pdfPath,
						sourceDirectory: typeof body.sourceDirectory === "string" ? body.sourceDirectory : undefined,
						paperId: typeof body.paperId === "string" ? body.paperId : undefined,
						namespace: typeof body.namespace === "string" ? body.namespace : undefined,
						additionalCandidateUrls: stringArray(body.additionalCandidateUrls),
					}),
				);
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
			if (request.method === "POST" && url.pathname === "/api/artifacts/prepare") {
				const body = await readJson(request);
				if (typeof body.pdfPath !== "string") throw new ApiError(400, "pdfPath is required");
				const input: ArtifactAcquisitionPreparationInput = {
					pdfPath: body.pdfPath,
					sourceDirectory: typeof body.sourceDirectory === "string" ? body.sourceDirectory : undefined,
					paperId: typeof body.paperId === "string" ? body.paperId : undefined,
					namespace: typeof body.namespace === "string" ? body.namespace : undefined,
					additionalCandidateUrls: stringArray(body.additionalCandidateUrls),
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
			if (url.pathname.startsWith("/api/team/")) {
				await handleTeamRoutes(application, request, response, url);
				return;
			}
			if (await handleResearchRoutes(application, request, response, url)) return;
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
			if (request.method === "POST" && url.pathname === "/api/artifacts/execute") {
				const body = await readJson(request);
				if (typeof body.pdfPath !== "string") throw new ApiError(400, "pdfPath is required");
				const input: ArtifactAcquisitionPreparationInput = {
					pdfPath: body.pdfPath,
					sourceDirectory: typeof body.sourceDirectory === "string" ? body.sourceDirectory : undefined,
					paperId: typeof body.paperId === "string" ? body.paperId : undefined,
					namespace: typeof body.namespace === "string" ? body.namespace : undefined,
					additionalCandidateUrls: stringArray(body.additionalCandidateUrls),
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
