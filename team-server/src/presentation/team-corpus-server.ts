import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createTeamKnowledgeService, type TeamKnowledgeService } from "../application/team-knowledge-service.ts";
import { hashTeamTokenValue, type TeamIdentitySeed, TeamTokenRegistry } from "../infrastructure/team-token-registry.ts";

export type { TeamIdentitySeed as TeamIdentity, TeamRole } from "../domain/team-identity.ts";

import { canAccessTeamNamespace, publicTeamIdentity, TeamIdentityError } from "../domain/team-identity.ts";
import { handleTeamIdentityRoutes } from "./team-identity-routes.ts";

export interface TeamCorpusServerConfig {
	root: string;
	identities: TeamIdentitySeed[];
	identityStorePath?: string;
	backupRoot?: string;
	maxBodyBytes?: number;
	maxBlobBytes?: number;
	tls?: {
		cert: string | Buffer;
		key: string | Buffer;
	};
}

import {
	artifactBody,
	derivedRecordsBody,
	HttpError,
	json,
	listParameter,
	namespaceFromPath,
	namespaceRoot,
	objectBody,
	pagination,
	permits,
	readBody,
	readJsonBody,
	recordsBody,
	rejectForbidden,
	rejectRequest,
	reviewBody,
	versionHeaders,
} from "./team-corpus-http.ts";

export function createTeamCorpusServer(config: TeamCorpusServerConfig) {
	const root = resolve(config.root);
	const maxBodyBytes = config.maxBodyBytes ?? 8 * 1024 * 1024;
	const maxBlobBytes = config.maxBlobBytes ?? 200 * 1024 * 1024;
	const backupRoot = config.backupRoot ? resolve(config.backupRoot) : undefined;
	const registry = new TeamTokenRegistry(root, config.identities, config.identityStorePath);
	const stores = new Map<string, Promise<TeamKnowledgeService>>();
	const storeFor = (namespace: string): Promise<TeamKnowledgeService> => {
		let store = stores.get(namespace);
		if (!store) {
			store = Promise.resolve(createTeamKnowledgeService(namespaceRoot(root, namespace), namespace));
			stores.set(namespace, store);
		}
		return store;
	};
	const handleRequest = async (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
	) => {
		if (config.tls) response.setHeader("strict-transport-security", "max-age=31536000");
		try {
			const url = new URL(request.url ?? "/", "http://paper-agent.invalid");
			if (request.method === "GET" && url.pathname === "/health") {
				json(response, 200, { ok: true, service: "paper-agent-team-corpus", version: 2 });
				return;
			}
			const authorization = request.headers.authorization;
			const identity = authorization?.startsWith("Bearer ")
				? await registry.authenticate(authorization.slice(7))
				: undefined;
			if (!identity) {
				json(response, 401, { error: "authentication required" });
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/whoami") {
				json(response, 200, { identity: publicTeamIdentity(identity) });
				return;
			}

			if (await handleTeamIdentityRoutes(request, response, url.pathname, identity, registry, maxBodyBytes)) return;

			const route = namespaceFromPath(url.pathname);
			if (!route) {
				json(response, 404, { error: "not found" });
				return;
			}
			if (!canAccessTeamNamespace(identity, route.namespace)) rejectForbidden("namespace access denied");
			const store = await storeFor(route.namespace);
			const actor = { id: identity.id, name: identity.name };

			if (request.method === "GET" && route.resource === "search") {
				if (!permits(identity, "reader")) rejectForbidden("reader role required");
				const yearFrom = url.searchParams.has("yearFrom") ? Number(url.searchParams.get("yearFrom")) : undefined;
				const yearTo = url.searchParams.has("yearTo") ? Number(url.searchParams.get("yearTo")) : undefined;
				const { offset, limit } = pagination(url);
				const openAccessValue = url.searchParams.get("openAccess");
				const openAccess =
					openAccessValue === null
						? undefined
						: openAccessValue === "true"
							? true
							: openAccessValue === "false"
								? false
								: "invalid";
				if (
					(yearFrom !== undefined && (!Number.isInteger(yearFrom) || yearFrom < 1000 || yearFrom > 9999)) ||
					(yearTo !== undefined && (!Number.isInteger(yearTo) || yearTo < 1000 || yearTo > 9999)) ||
					openAccess === "invalid"
				)
					rejectRequest("year filters and openAccess are invalid");
				const searchOptions = {
					query: url.searchParams.get("q") ?? undefined,
					yearFrom,
					yearTo,
					authors: listParameter(url, "author"),
					venues: listParameter(url, "venue"),
					types: listParameter(url, "type"),
					openAccess,
					offset,
					limit,
				};
				const hits = await store.literature.searchPapers({ ...searchOptions, readOnly: true });
				const hasMore =
					hits.length === limit &&
					(
						await store.literature.searchPapers({
							...searchOptions,
							offset: offset + hits.length,
							limit: 1,
							readOnly: true,
						})
					).length > 0;
				json(response, 200, {
					hits,
					cursor: offset,
					nextCursor: hasMore ? String(offset + hits.length) : undefined,
				});
				return;
			}
			if (request.method === "GET" && route.resource === "proposals") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const { offset, limit } = pagination(url);
				const pending = (await store.literature.listPapers()).filter(
					(record) => record.curation?.teamReview?.status === "team-proposed",
				);
				json(response, 200, {
					records: pending.slice(offset, offset + limit),
					nextCursor: offset + limit < pending.length ? String(offset + limit) : undefined,
				});
				return;
			}
			if (request.method === "GET" && route.resource.startsWith("papers/")) {
				if (!permits(identity, "reader")) rejectForbidden("reader role required");
				const record = await store.literature.getPaper(decodeURIComponent(route.resource.slice(7)));
				json(response, record ? 200 : 404, record ?? { error: "paper not found" });
				return;
			}
			if (request.method === "POST" && route.resource === "proposals") {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				const records = recordsBody(await readJsonBody(request, maxBodyBytes));
				const promoted = await store.proposePapers(records, actor);
				json(response, 200, { promoted, contributor: identity.name });
				return;
			}
			if (request.method === "POST" && route.resource === "reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "paperIds");
				const reviewed = await store.reviewPapers(review.ids, review.decision, actor, review.reason);
				json(response, 200, { reviewed });
				return;
			}
			if (request.method === "GET" && route.resource === "derived") {
				if (!permits(identity, "reader") && !permits(identity, "reviewer"))
					rejectForbidden("reader or reviewer role required");
				json(response, 200, {
					entries: await store.listDerived({
						paperId: url.searchParams.get("paperId") ?? undefined,
						includePending: permits(identity, "reviewer") && url.searchParams.get("pending") === "true",
					}),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "derived") {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				json(response, 200, {
					entries: await store.proposeDerived(
						derivedRecordsBody(await readJsonBody(request, maxBodyBytes)),
						actor,
					),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "derived/reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "keys");
				json(response, 200, {
					entries: await store.reviewDerived(review.ids, review.decision, actor, review.reason),
				});
				return;
			}
			if (request.method === "GET" && route.resource === "artifacts") {
				if (!permits(identity, "reader") && !permits(identity, "reviewer"))
					rejectForbidden("reader or reviewer role required");
				json(response, 200, {
					entries: await store.listArtifacts(
						permits(identity, "reviewer") && url.searchParams.get("pending") === "true",
					),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "artifacts") {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				const artifact = artifactBody(await readJsonBody(request, maxBodyBytes));
				json(response, 200, {
					entry: await store.proposeArtifact(artifact.paperId, artifact.manifest, actor),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "artifacts/reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "paperIds");
				json(response, 200, {
					entries: await store.reviewArtifact(review.ids, review.decision, actor, review.reason),
				});
				return;
			}
			const blobRoute = /^blobs\/([a-f0-9]{64})$/.exec(route.resource);
			if (request.method === "PUT" && blobRoute) {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				const body = await readBody(request, maxBlobBytes);
				if (createHash("sha256").update(body).digest("hex") !== blobRoute[1]) {
					rejectRequest("uploaded blob SHA-256 does not match the request path");
				}
				json(response, 200, await store.putBlob(body, blobRoute[1], actor, versionHeaders(request)));
				return;
			}
			if (request.method === "GET" && blobRoute) {
				if (!permits(identity, "reader")) rejectForbidden("reader role required");
				const blob = await store.readBlob(blobRoute[1]);
				response.writeHead(200, {
					"content-type": blob.contentType,
					"content-length": blob.body.length,
					"cache-control": "private, max-age=31536000, immutable",
					"x-content-type-options": "nosniff",
					etag: `"sha256-${blobRoute[1]}"`,
				});
				response.end(blob.body);
				return;
			}
			if (request.method === "GET" && route.resource === "events") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const { offset, limit } = pagination(url);
				json(response, 200, await store.listAuditEvents(offset, limit));
				return;
			}
			if (request.method === "GET" && route.resource === "stats") {
				if (!permits(identity, "reader")) rejectForbidden("reader role required");
				json(response, 200, await store.stats());
				return;
			}
			if (request.method === "GET" && route.resource === "audit") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				json(response, 200, await store.literature.audit({ readOnly: true }));
				return;
			}
			if (request.method === "POST" && route.resource === "backups") {
				if (!permits(identity, "admin")) rejectForbidden("admin role required");
				if (!backupRoot) throw new Error("backupRoot is not configured");
				json(response, 200, await store.backupTo(backupRoot, await registry.backupSnapshot(), actor));
				return;
			}
			if (request.method === "POST" && route.resource === "backups/drill") {
				if (!permits(identity, "admin")) rejectForbidden("admin role required");
				if (!backupRoot) throw new Error("backupRoot is not configured");
				const body = objectBody(
					await readJsonBody(request, maxBodyBytes),
					"restore drill request must be a JSON object",
				);
				if (typeof body.backupPath !== "string") rejectRequest("backupPath is required");
				const candidate = resolve(body.backupPath);
				const path = relative(backupRoot, candidate);
				if (!path || path.startsWith("..") || isAbsolute(path))
					rejectRequest("backupPath must identify a bundle under the configured backup root");
				json(response, 200, await store.restoreDrill(candidate, join(backupRoot, ".restore-drills"), actor));
				return;
			}
			json(response, 405, { error: "method not allowed" });
		} catch (error) {
			if (error instanceof HttpError || error instanceof TeamIdentityError) {
				json(response, error.status, { error: error.message });
				return;
			}
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				json(response, 404, { error: "not found" });
				return;
			}
			console.error("Unexpected team corpus request failure", error);
			json(response, 500, { error: "internal server error" });
		}
	};
	return config.tls ? createHttpsServer(config.tls, handleRequest) : createHttpServer(handleRequest);
}

export function hashTeamToken(token: string): string {
	return hashTeamTokenValue(token);
}
