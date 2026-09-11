import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createTeamKnowledgeService, type TeamKnowledgeService } from "../application/team-knowledge-service.ts";
import { hashTeamTokenValue, type TeamIdentitySeed, TeamTokenRegistry } from "../infrastructure/team-token-registry.ts";

export type { TeamIdentitySeed as TeamIdentity, TeamRole } from "../domain/team-identity.ts";

import { canAccessTeamNamespace, publicTeamIdentity, TeamIdentityError } from "../domain/team-identity.ts";
import { proposedByIdentity, TeamPaperConflictError } from "../domain/team-literature-repository.ts";
import type { SharedReviewStatus } from "../protocol/team-corpus-types.ts";
import { handleTeamIdentityRoutes } from "./team-identity-routes.ts";

const sharedReviewStatuses: SharedReviewStatus[] = ["team-proposed", "team-approved", "team-rejected"];

/** Per-IP budget for failed authentication attempts, plus the window those failures are counted over. */
const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 60_000;

interface AccessContext {
	address?: string;
	identityId?: string;
	namespace?: string;
}

/** Redacted access log line: never carries headers, bodies, tokens, or invite strings. */
export function writeAccessLog(entry: {
	at: string;
	method: string;
	path: string;
	status: number;
	ms: number;
	identityId?: string;
	namespace?: string;
}): void {
	process.stdout.write(`${JSON.stringify(entry)}\n`);
}

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
	paperIdsBody,
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
	const authFailures = new Map<string, { count: number; resetAt: number }>();
	const rateLimitExceeded = (address: string): boolean => {
		const entry = authFailures.get(address);
		return Boolean(entry && entry.count >= AUTH_FAILURE_LIMIT && Date.now() < entry.resetAt);
	};
	const registerAuthFailure = (address: string): void => {
		const now = Date.now();
		const entry = authFailures.get(address);
		if (!entry || now >= entry.resetAt) {
			authFailures.set(address, { count: 1, resetAt: now + AUTH_FAILURE_WINDOW_MS });
			return;
		}
		entry.count += 1;
	};
	const handleRequest = async (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
		context: AccessContext = {},
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
				// Only requests that fail authentication are throttled. A valid token from the same address keeps
				// working, so one misconfigured client behind a shared NAT cannot lock out the rest of the lab.
				if (context.address !== undefined && rateLimitExceeded(context.address)) {
					json(response, 429, { error: "too many authentication failures" });
				} else {
					json(response, 401, { error: "authentication required" });
				}
				return;
			}
			context.identityId = identity.id;
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
			context.namespace = route.namespace;
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
				const requestedStatuses = listParameter(url, "status");
				if (requestedStatuses?.some((status) => !sharedReviewStatuses.includes(status as SharedReviewStatus)))
					rejectRequest("status must be team-proposed, team-approved, or team-rejected");
				// Records that are still pending or were rejected stay invisible to plain readers.
				if (
					requestedStatuses?.some((status) => status !== "team-approved") &&
					!permits(identity, "reviewer")
				)
					rejectForbidden("reviewer role required to read non-approved records");
				const reviewStatuses = requestedStatuses as SharedReviewStatus[] | undefined;
				const searchOptions = {
					query: url.searchParams.get("q") ?? undefined,
					yearFrom,
					yearTo,
					authors: listParameter(url, "author"),
					venues: listParameter(url, "venue"),
					types: listParameter(url, "type"),
					openAccess,
					reviewStatuses,
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
				// `mine=true` lets contributors audit their own pending proposals; reviewers keep the full queue.
				const mine = url.searchParams.get("mine") === "true";
				if (mine ? !permits(identity, "contributor") : !permits(identity, "reviewer"))
					rejectForbidden(mine ? "contributor role required" : "reviewer role required");
				const { offset, limit } = pagination(url);
				// Pending work is new proposals plus parked revisions of approved records (flagged `revision: true`).
				const pending = (await store.literature.listPendingPapers()).filter(
					(record) => !mine || proposedByIdentity(record.curation?.teamReview, identity),
				);
				json(response, 200, {
					records: pending.slice(offset, offset + limit),
					nextCursor: offset + limit < pending.length ? String(offset + limit) : undefined,
				});
				return;
			}
			// `/versions` must be matched before the single-paper read so the suffix is not treated as an id.
			const versionRoute = /^papers\/(.+)\/versions$/.exec(route.resource);
			if (request.method === "GET" && versionRoute) {
				if (!permits(identity, "reader")) rejectForbidden("reader role required");
				const paperId = decodeURIComponent(versionRoute[1]);
				const record = await store.literature.getPaper(paperId);
				if (!record || (record.curation?.teamReview?.status !== "team-approved" && !permits(identity, "reviewer")))
					json(response, 404, { error: "paper not found" });
				else json(response, 200, { versions: await store.literature.listPaperVersions(paperId) });
				return;
			}
			if (request.method === "GET" && route.resource.startsWith("papers/")) {
				if (!permits(identity, "reader")) rejectForbidden("reader role required");
				const record = await store.literature.getPaper(decodeURIComponent(route.resource.slice(7)));
				// Non-approved records are hidden from plain readers; use 404 so their existence never leaks.
				if (!record || (record.curation?.teamReview?.status !== "team-approved" && !permits(identity, "reviewer")))
					json(response, 404, { error: "paper not found" });
				else json(response, 200, record);
				return;
			}
			if (request.method === "POST" && route.resource === "proposals/withdraw") {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				const paperIds = paperIdsBody(await readJsonBody(request, maxBodyBytes), "withdraw");
				try {
					json(response, 200, { withdrawn: await store.withdrawPapers(paperIds, actor) });
				} catch (error) {
					// Any rule violation rejects the whole batch with 400; nothing is partially withdrawn.
					rejectRequest(error instanceof Error ? error.message : "withdraw failed");
				}
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
			if (error instanceof TeamPaperConflictError) {
				json(response, 409, { error: error.message });
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
	const accessLogEnabled = process.env.PAPER_AGENT_TEAM_ACCESS_LOG !== "off";
	const guarded = async (
		request: import("node:http").IncomingMessage,
		response: import("node:http").ServerResponse,
	) => {
		const startedAt = Date.now();
		const at = new Date().toISOString();
		let pathname = "/";
		try {
			pathname = new URL(request.url ?? "/", "http://paper-agent.invalid").pathname;
		} catch {
			/* Keep the generic path for malformed URLs. */
		}
		const address = request.socket.remoteAddress ?? "unknown";
		const context: AccessContext = { address };
		try {
			await handleRequest(request, response, context);
		} finally {
			if (response.statusCode === 401) registerAuthFailure(address);
			if (accessLogEnabled) {
				writeAccessLog({
					at,
					method: request.method ?? "GET",
					path: pathname,
					status: response.statusCode,
					ms: Date.now() - startedAt,
					identityId: context.identityId,
					namespace: context.namespace,
				});
			}
		}
	};
	const server = config.tls ? createHttpsServer(config.tls, guarded) : createHttpServer(guarded);
	const cleanup = setInterval(() => {
		const now = Date.now();
		for (const [address, entry] of authFailures) if (now >= entry.resetAt) authFailures.delete(address);
	}, AUTH_FAILURE_WINDOW_MS);
	cleanup.unref();
	server.on("close", () => clearInterval(cleanup));
	return server;
}

export function hashTeamToken(token: string): string {
	return hashTeamTokenValue(token);
}
