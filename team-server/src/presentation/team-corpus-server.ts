import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createTeamKnowledgeService, type TeamKnowledgeService } from "../application/team-knowledge-service.ts";
import { hashTeamTokenValue, type TeamIdentitySeed, TeamTokenRegistry } from "../infrastructure/team-token-registry.ts";

export type { TeamIdentitySeed as TeamIdentity, TeamRole } from "../domain/team-identity.ts";

import { canAccessTeamNamespace, publicTeamIdentity, TeamIdentityError } from "../domain/team-identity.ts";
import { proposedByIdentity, TeamPaperConflictError } from "../domain/team-literature-repository.ts";
import { TeamStateError } from "../domain/team-state-error.ts";
import type { SharedReviewStatus, TeamActor, TeamTopic } from "../protocol/team-corpus-types.ts";
import type { PaperRecord } from "../protocol/literature-types.ts";
import { handleTeamIdentityRoutes } from "./team-identity-routes.ts";
import { handleTeamContentRoutes } from "./team-content-routes.ts";

const sharedReviewStatuses: SharedReviewStatus[] = ["team-proposed", "team-approved", "team-rejected"];

/**
 * Paper ids referenced by the requested categories. Unknown ids contribute nothing, so a stale or foreign
 * category filter yields an empty page instead of an error that would confirm whether the category exists.
 * An empty result is still a filter, not "no filter": the caller passes `[]` and gets no records.
 */
export function paperIdsForTopics(topics: TeamTopic[], requested: string[]): string[] {
	const wanted = new Set(requested);
	const ids = new Set<string>();
	for (const topic of topics) {
		if (!wanted.has(topic.id)) continue;
		for (const entry of topic.entries) if (entry.resource === "papers") ids.add(entry.id);
	}
	return [...ids];
}

/**
 * Honours the categories an approved proposal asked its records to join. The caller is the reviewer whose
 * decision published those records, so the category write carries the authority of that approval rather than
 * the proposer's. Each category is written at most once per call, and a category that no longer exists or was
 * changed concurrently is reported as skipped instead of failing a review that already happened.
 */
async function applyRequestedCategories(
	store: TeamKnowledgeService,
	actor: TeamActor,
	approved: PaperRecord[],
): Promise<{ applied: string[]; skipped: string[] }> {
	const requested = new Map<string, string[]>();
	for (const record of approved) {
		if (record.curation?.teamReview?.status !== "team-approved") continue;
		for (const topicId of record.curation.teamReview.requestedTopicIds ?? []) {
			requested.set(topicId, [...(requested.get(topicId) ?? []), record.id]);
		}
	}
	const skipped: string[] = [];
	if (!requested.size) return { applied: [], skipped };
	const applied: string[] = [];
	const topics = await store.collaboration.topics();
	for (const [topicId, paperIds] of requested) {
		const topic = topics.find((entry) => entry.id === topicId);
		if (!topic) {
			skipped.push(topicId);
			continue;
		}
		const entries = [...topic.entries];
		const seen = new Set(entries.map((entry) => `${entry.resource}:${entry.id}`));
		for (const paperId of paperIds) {
			const key = `papers:${paperId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({ resource: "papers", id: paperId });
		}
		if (entries.length === topic.entries.length) {
			// Every approved paper is already filed here: nothing to write, nothing to audit.
			applied.push(topicId);
			continue;
		}
		try {
			await store.collaboration.changeTopic(
				{
					id: topic.id,
					title: topic.title,
					description: topic.description,
					entries,
					expectedVersion: topic.version,
				},
				actor,
			);
			await store.appendAudit(actor, "topic.save", topicId);
			applied.push(topicId);
		} catch {
			// A concurrent category edit wins; retrying later must not require re-approving the paper.
			skipped.push(topicId);
		}
	}
	return { applied, skipped };
}

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
	pageSnapshotsBody,
	permits,
	readJsonBody,
	recordsBody,
	rejectForbidden,
	rejectRequest,
	reviewBody,
	reviewPreviewBody,
	topicIdsBody,
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
			const service = createTeamKnowledgeService(namespaceRoot(root, namespace), namespace);
			store = service
				.recover()
				.then(() => service)
				.catch((error) => {
					stores.delete(namespace);
					throw error;
				});
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
			if (
				await handleTeamContentRoutes({
					request,
					response,
					url,
					resourcePath: route.resource,
					namespace: route.namespace,
					identity,
					registry,
					store,
					maxBodyBytes,
				})
			)
				return;

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
				if (requestedStatuses?.some((status) => status !== "team-approved") && !permits(identity, "reviewer"))
					rejectForbidden("reviewer role required to read non-approved records");
				const reviewStatuses = requestedStatuses as SharedReviewStatus[] | undefined;
				// Category filter: resolve the categories here, because the literature repository cannot read
				// the collaboration store that owns `topics/`.
				const requestedTopics = listParameter(url, "topic");
				const paperIds = requestedTopics
					? paperIdsForTopics(await store.collaboration.topics(), requestedTopics)
					: undefined;
				const searchOptions = {
					query: url.searchParams.get("q") ?? undefined,
					yearFrom,
					yearTo,
					authors: listParameter(url, "author"),
					venues: listParameter(url, "venue"),
					types: listParameter(url, "type"),
					openAccess,
					reviewStatuses,
					paperIds,
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
				else {
					const versions = await store.literature.listPaperVersions(paperId);
					json(response, 200, {
						versions: versions
							.filter(
								(version) =>
									(permits(identity, "reviewer") && url.searchParams.get("pending") === "true") ||
									!version.teamReview ||
									version.teamReview.status === "team-approved",
							)
							.map(({ blobPath: _path, ...version }) => version),
					});
				}
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
				const body = objectBody(await readJsonBody(request, maxBodyBytes), "Expected withdrawal input");
				const paperIds = paperIdsBody(body, "withdraw");
				const expected =
					body.expectedVersions === undefined
						? undefined
						: objectBody(body.expectedVersions, "Invalid withdrawal versions");
				if (
					expected &&
					paperIds.some((id) => typeof expected[id] !== "string" || !/^[a-f0-9]{64}$/.test(expected[id] as string))
				)
					rejectRequest("Every withdrawal target needs a valid version");
				try {
					json(response, 200, {
						withdrawn: await store.withdrawPapers(
							paperIds,
							actor,
							expected as Record<string, string> | undefined,
						),
					});
				} catch (error) {
					if (error instanceof TeamStateError) throw error;
					// Any rule violation rejects the whole batch with 400; nothing is partially withdrawn.
					rejectRequest(error instanceof Error ? error.message : "withdraw failed");
				}
				return;
			}
			if (request.method === "POST" && route.resource === "proposals") {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				const body = await readJsonBody(request, maxBodyBytes);
				const records = recordsBody(body);
				// A category request is recorded on the review envelope; a reviewer applies it on approval.
				const requestedTopicIds = topicIdsBody(body);
				const promoted = await store.proposePapers(records, actor, requestedTopicIds);
				json(response, 200, { promoted, contributor: identity.name, requestedTopicIds });
				return;
			}
			if (request.method === "POST" && route.resource === "reviews/preview") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const input = reviewPreviewBody(await readJsonBody(request, maxBodyBytes));
				json(response, 200, { entries: await store.previewReview(input.resource, input.ids) });
				return;
			}
			if (request.method === "POST" && route.resource === "reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "paperIds");
				const reviewed = await store.reviewPapers(
					review.ids,
					review.decision,
					actor,
					review.reason,
					review.expectedVersions,
				);
				// Approval is the only moment a category request can be honoured: only reviewers may write
				// categories, and approving is what publishes the record those categories will reference.
				const categories =
					review.decision === "team-approved"
						? await applyRequestedCategories(store, actor, reviewed)
						: { applied: [], skipped: [] };
				json(response, 200, { reviewed, categories });
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
					entries: await store.reviewDerived(
						review.ids,
						review.decision,
						actor,
						review.reason,
						review.expectedVersions,
					),
				});
				return;
			}
			if (request.method === "GET" && route.resource === "pages") {
				if (!permits(identity, "reader") && !permits(identity, "reviewer"))
					rejectForbidden("reader or reviewer role required");
				json(response, 200, {
					entries: await store.listPages(
						permits(identity, "reviewer") && url.searchParams.get("pending") === "true"
							? { includePending: true }
							: {},
					),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "pages") {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				json(response, 200, {
					entries: await store.proposePages(pageSnapshotsBody(await readJsonBody(request, maxBodyBytes)), actor),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "pages/reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "keys");
				json(response, 200, {
					entries: await store.reviewPages(
						review.ids,
						review.decision,
						actor,
						review.reason,
						review.expectedVersions,
					),
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
					entries: await store.reviewArtifact(
						review.ids,
						review.decision,
						actor,
						review.reason,
						review.expectedVersions,
					),
				});
				return;
			}
			const blobRoute = /^blobs\/([a-f0-9]{64})$/.exec(route.resource);
			if (request.method === "PUT" && blobRoute) {
				if (!permits(identity, "contributor")) rejectForbidden("contributor role required");
				if (Number(request.headers["content-length"] ?? 0) > maxBlobBytes)
					throw new TeamStateError(413, "Blob exceeds configured size limit");
				try {
					const stored = await store.putBlobStream(
						request.iterator({ destroyOnReturn: false }),
						blobRoute[1],
						maxBlobBytes,
						actor,
						versionHeaders(request),
					);
					json(response, 200, { sha256: stored.sha256, bytes: stored.bytes, existed: stored.existed });
				} catch (error) {
					request.resume();
					throw error;
				}
				return;
			}
			if (request.method === "GET" && blobRoute) {
				if (!permits(identity, "reader") && !permits(identity, "reviewer"))
					rejectForbidden("reader or reviewer role required");
				const blob = await store.locateBlob(blobRoute[1], { includePending: permits(identity, "reviewer") });
				response.writeHead(200, {
					"content-type": blob.contentType,
					"content-disposition":
						blob.contentType === "application/pdf" ? "inline" : `attachment; filename="${blobRoute[1]}.bin"`,
					"content-length": blob.bytes,
					"cache-control": "private, no-store",
					"x-content-type-options": "nosniff",
					etag: `"sha256-${blobRoute[1]}"`,
				});
				await pipeline(createReadStream(blob.path), response);
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
				json(response, 200, await store.stats({ includePending: permits(identity, "reviewer") }));
				return;
			}
			if (request.method === "GET" && route.resource === "maintenance") {
				if (!permits(identity, "admin")) rejectForbidden("admin role required");
				json(response, 200, await store.maintenance());
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
			if (response.headersSent) {
				response.destroy();
				return;
			}
			if (error instanceof HttpError || error instanceof TeamIdentityError || error instanceof TeamStateError) {
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
