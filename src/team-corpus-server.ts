import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactManifest, DerivedRecord, PaperRecord, PaperVersion } from "./literature-types.ts";
import { validateTeamNamespace } from "./team-corpus-validation.ts";
import { TeamKnowledgeStore } from "./team-knowledge-store.ts";
import { hashTeamTokenValue, type TeamIdentity, type TeamRole, TeamTokenRegistry } from "./team-token-registry.ts";

export type { TeamIdentity, TeamRole } from "./team-token-registry.ts";

export interface TeamCorpusServerConfig {
	root: string;
	identities: TeamIdentity[];
	identityStorePath?: string;
	backupRoot?: string;
	maxBodyBytes?: number;
	maxBlobBytes?: number;
}

class HttpError extends Error {
	readonly status: 400 | 403 | 404 | 413;

	constructor(status: 400 | 403 | 404 | 413, message: string) {
		super(message);
		this.status = status;
	}
}

function rejectRequest(message: string): never {
	throw new HttpError(400, message);
}

function rejectForbidden(message: string): never {
	throw new HttpError(403, message);
}

function permits(identity: TeamIdentity, role: TeamRole): boolean {
	return identity.roles.includes("admin") || identity.roles.includes(role);
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

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const declared = Number(request.headers["content-length"] ?? 0);
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new HttpError(413, "request body exceeds configured limit");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new HttpError(413, "request body exceeds configured limit");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
	const body = await readBody(request, maxBytes);
	if (body.length === 0) return {};
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		rejectRequest("request body must contain valid JSON");
	}
}

function objectBody(value: unknown, message: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) rejectRequest(message);
	return value as Record<string, unknown>;
}

function namespaceFromPath(pathname: string): { namespace: string; resource: string } | undefined {
	const match = /^\/v1\/namespaces\/([^/]+)\/(.+)$/.exec(pathname);
	if (!match) return undefined;
	try {
		return {
			namespace: validateTeamNamespace(decodeURIComponent(match[1])),
			resource: match[2],
		};
	} catch (error) {
		rejectRequest(error instanceof Error ? error.message : "invalid namespace");
	}
}

function isHttpUrl(value: string): boolean {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

const provenanceProviders = new Set([
	"arxiv",
	"openalex",
	"crossref",
	"semanticscholar",
	"dblp",
	"pubmed",
	"core",
	"opencitations",
	"unpaywall",
	"local-pdf",
	"bibtex-import",
	"json-import",
]);

function validRecord(record: unknown): record is PaperRecord {
	if (typeof record !== "object" || record === null) return false;
	const value = record as PaperRecord;
	if (!value.id?.trim() || value.id.length > 64 || !value.title?.trim() || value.title.length > 10_000) return false;
	if (value.abstract !== undefined && (typeof value.abstract !== "string" || value.abstract.length > 200_000))
		return false;
	if (value.venue !== undefined && (typeof value.venue !== "string" || value.venue.length > 2_000)) return false;
	if (
		value.publicationType !== undefined &&
		(typeof value.publicationType !== "string" || value.publicationType.length > 500)
	)
		return false;
	if (value.year !== undefined && (!Number.isInteger(value.year) || value.year < 1000 || value.year > 9999))
		return false;
	if (value.citationCount !== undefined && (!Number.isInteger(value.citationCount) || value.citationCount < 0))
		return false;
	if (
		!Array.isArray(value.authors) ||
		value.authors.length > 1_000 ||
		!value.authors.every((author) => typeof author === "string" && author.trim() && author.length <= 2_000)
	)
		return false;
	if (
		typeof value.identifiers !== "object" ||
		value.identifiers === null ||
		!Object.values(value.identifiers).every(
			(identifier) => identifier === undefined || typeof identifier === "string",
		)
	)
		return false;
	if (
		!Array.isArray(value.links) ||
		value.links.length > 2_000 ||
		!value.links.every(
			(link) =>
				typeof link === "object" &&
				link !== null &&
				typeof link.url === "string" &&
				isHttpUrl(link.url) &&
				["landing", "pdf", "doi", "artifact", "other"].includes(link.kind) &&
				(link.openAccess === undefined || typeof link.openAccess === "boolean"),
		)
	)
		return false;
	if (
		!Array.isArray(value.provenance) ||
		value.provenance.length === 0 ||
		value.provenance.length > 2_000 ||
		!value.provenance.every(
			(event) =>
				typeof event === "object" &&
				event !== null &&
				provenanceProviders.has(event.provider) &&
				typeof event.query === "string" &&
				event.query.trim().length > 0 &&
				typeof event.retrievedAt === "string" &&
				Number.isFinite(Date.parse(event.retrievedAt)) &&
				(event.providerRecordId === undefined || typeof event.providerRecordId === "string") &&
				(event.rawUrl === undefined || (typeof event.rawUrl === "string" && isHttpUrl(event.rawUrl))),
		)
	)
		return false;
	if (
		value.referencedWorks !== undefined &&
		(!Array.isArray(value.referencedWorks) ||
			value.referencedWorks.length > 10_000 ||
			!value.referencedWorks.every((id) => typeof id === "string" && id.trim() && id.length <= 2_000))
	)
		return false;
	if (
		value.citedByApiUrl !== undefined &&
		(typeof value.citedByApiUrl !== "string" || !isHttpUrl(value.citedByApiUrl))
	)
		return false;
	if (
		value.materialHashes !== undefined &&
		(!Array.isArray(value.materialHashes) ||
			value.materialHashes.length > 1_000 ||
			!value.materialHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)))
	)
		return false;
	return (
		Array.isArray(value.mergedFrom) &&
		value.mergedFrom.length <= 10_000 &&
		value.mergedFrom.every((id) => typeof id === "string" && id.trim() && id.length <= 2_000)
	);
}

function recordsBody(value: unknown): PaperRecord[] {
	const body = objectBody(value, "proposal request must be a JSON object");
	if (!Array.isArray(body.records)) rejectRequest("records[] is required");
	if (body.records.length > 500) rejectRequest("a proposal is limited to 500 records");
	if (!body.records.every(validRecord))
		rejectRequest(
			"every proposed record requires bounded text, public HTTP(S) links, valid provenance, and mergedFrom[]",
		);
	return body.records;
}

function derivedRecordsBody(value: unknown): DerivedRecord[] {
	const body = objectBody(value, "derived proposal request must be a JSON object");
	if (!Array.isArray(body.records) || body.records.length === 0) rejectRequest("records[] is required");
	if (body.records.length > 200) rejectRequest("a derived proposal is limited to 200 records");
	for (const record of body.records as DerivedRecord[]) {
		if (
			!record ||
			typeof record !== "object" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.key) ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.paperId) ||
			typeof record.operation !== "string" ||
			record.operation.length > 200 ||
			!Array.isArray(record.inputHashes) ||
			record.inputHashes.length > 200 ||
			!record.inputHashes.every((hash) => /^[a-f0-9]{64}$/i.test(hash)) ||
			typeof record.pipelineVersion !== "string" ||
			typeof record.createdAt !== "string" ||
			!Number.isFinite(Date.parse(record.createdAt))
		) {
			rejectRequest(
				"derived records require safe keys, paper ids, bounded operation metadata, input SHA-256 values, and a valid timestamp",
			);
		}
	}
	return body.records as DerivedRecord[];
}

function artifactBody(value: unknown): { paperId: string; manifest: ArtifactManifest } {
	const body = objectBody(value, "artifact proposal request must be a JSON object");
	if (typeof body.paperId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.paperId))
		rejectRequest("paperId is required");
	const manifest = body.manifest as ArtifactManifest | undefined;
	if (
		!manifest ||
		typeof manifest !== "object" ||
		manifest.schemaVersion !== 1 ||
		typeof manifest.pdfPath !== "string" ||
		!/^[a-f0-9]{64}$/i.test(manifest.pdfSha256) ||
		!Array.isArray(manifest.candidates) ||
		manifest.candidates.length > 2_000 ||
		!Array.isArray(manifest.acquisitions) ||
		manifest.acquisitions.length > 2_000
	) {
		rejectRequest("a bounded artifact manifest with a PDF SHA-256 is required");
	}
	return { paperId: body.paperId, manifest };
}

function reviewBody(
	value: unknown,
	key: "paperIds" | "keys",
): { ids: string[]; decision: "team-approved" | "team-rejected"; reason?: string } {
	const body = objectBody(value, "review request must be a JSON object");
	const ids = body[key];
	if (
		!Array.isArray(ids) ||
		ids.length === 0 ||
		ids.length > 500 ||
		!ids.every((id) => typeof id === "string" && id.length <= 128)
	)
		rejectRequest(`${key}[] is required and limited to 500 entries`);
	if (body.decision !== "team-approved" && body.decision !== "team-rejected")
		rejectRequest("decision must be team-approved or team-rejected");
	if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 10_000))
		rejectRequest("review reason is invalid");
	return { ids, decision: body.decision, reason: body.reason as string | undefined };
}

function listParameter(url: URL, name: string): string[] | undefined {
	const values = url.searchParams
		.getAll(name)
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);
	return values.length ? [...new Set(values)] : undefined;
}

function pagination(url: URL, maximum = 500): { offset: number; limit: number } {
	const offset = Number(url.searchParams.get("cursor") ?? 0);
	const requested = Number(url.searchParams.get("limit") ?? 100);
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(requested) || requested < 1)
		rejectRequest("cursor must be a non-negative integer and limit must be positive");
	return { offset, limit: Math.min(requested, maximum) };
}

function namespaceRoot(root: string, namespace: string): string {
	const target = resolve(root, namespace);
	const path = relative(root, target);
	if (!path || path.startsWith("..") || isAbsolute(path))
		throw new Error("namespace resolves outside the configured team corpus root");
	return target;
}

function versionHeaders(request: IncomingMessage): Omit<PaperVersion, "sha256" | "bytes" | "blobPath"> | undefined {
	const paperId = request.headers["x-paper-id"];
	if (paperId === undefined) return undefined;
	const sourceUrl = request.headers["x-source-url"];
	const finalUrl = request.headers["x-final-url"];
	const retrievedAt = request.headers["x-retrieved-at"];
	if (
		typeof paperId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(paperId) ||
		typeof sourceUrl !== "string" ||
		!isHttpUrl(sourceUrl) ||
		typeof finalUrl !== "string" ||
		!isHttpUrl(finalUrl) ||
		typeof retrievedAt !== "string" ||
		!Number.isFinite(Date.parse(retrievedAt))
	)
		rejectRequest("blob version headers are invalid");
	return {
		paperId,
		sourceUrl,
		finalUrl,
		retrievedAt,
		contentType: request.headers["content-type"] ?? "application/octet-stream",
	};
}

export function createTeamCorpusServer(config: TeamCorpusServerConfig) {
	const root = resolve(config.root);
	const maxBodyBytes = config.maxBodyBytes ?? 8 * 1024 * 1024;
	const maxBlobBytes = config.maxBlobBytes ?? 200 * 1024 * 1024;
	const backupRoot = config.backupRoot ? resolve(config.backupRoot) : undefined;
	const registry = new TeamTokenRegistry(root, config.identities, config.identityStorePath);
	const stores = new Map<string, Promise<TeamKnowledgeStore>>();
	const storeFor = (namespace: string): Promise<TeamKnowledgeStore> => {
		let store = stores.get(namespace);
		if (!store) {
			store = Promise.resolve(new TeamKnowledgeStore(namespaceRoot(root, namespace), namespace));
			stores.set(namespace, store);
		}
		return store;
	};
	return createServer(async (request, response) => {
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
				json(response, 200, { identity: { name: identity.name, roles: identity.roles } });
				return;
			}

			if (request.method === "GET" && url.pathname === "/v1/admin/identities") {
				if (!permits(identity, "admin")) rejectForbidden("admin role required");
				json(response, 200, { identities: await registry.list() });
				return;
			}
			const tokenRoute = /^\/v1\/admin\/identities\/([^/]+)\/(rotate|revoke)$/.exec(url.pathname);
			if (request.method === "POST" && tokenRoute) {
				if (!permits(identity, "admin")) rejectForbidden("admin role required");
				const name = decodeURIComponent(tokenRoute[1]);
				if (tokenRoute[2] === "revoke") {
					if (name === identity.name) rejectRequest("the active administrator token cannot revoke itself");
					json(response, 200, { identity: await registry.revoke(name, identity.name) });
					return;
				}
				const body = objectBody(
					await readJsonBody(request, maxBodyBytes),
					"token rotation request must be a JSON object",
				);
				const roles = body.roles;
				if (
					roles !== undefined &&
					(!Array.isArray(roles) ||
						roles.length === 0 ||
						!roles.every((role) => ["reader", "contributor", "reviewer", "admin"].includes(String(role))))
				)
					rejectRequest("roles must contain valid team roles");
				json(response, 200, await registry.rotate(name, identity.name, roles as TeamRole[] | undefined));
				return;
			}

			const route = namespaceFromPath(url.pathname);
			if (!route) {
				json(response, 404, { error: "not found" });
				return;
			}
			const store = await storeFor(route.namespace);

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
						(await store.literature.searchPapers({
							...searchOptions,
							offset: offset + hits.length,
							limit: 1,
							readOnly: true,
						}))
							.length > 0;
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
				const promoted = await store.proposePapers(records, identity.name);
				json(response, 200, { promoted, contributor: identity.name });
				return;
			}
			if (request.method === "POST" && route.resource === "reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "paperIds");
				const reviewed = await store.reviewPapers(review.ids, review.decision, identity.name, review.reason);
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
						identity.name,
					),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "derived/reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "keys");
				json(response, 200, {
					entries: await store.reviewDerived(review.ids, review.decision, identity.name, review.reason),
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
					entry: await store.proposeArtifact(artifact.paperId, artifact.manifest, identity.name),
				});
				return;
			}
			if (request.method === "POST" && route.resource === "artifacts/reviews") {
				if (!permits(identity, "reviewer")) rejectForbidden("reviewer role required");
				const review = reviewBody(await readJsonBody(request, maxBodyBytes), "paperIds");
				json(response, 200, {
					entries: await store.reviewArtifact(review.ids, review.decision, identity.name, review.reason),
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
				json(response, 200, await store.putBlob(body, blobRoute[1], identity.name, versionHeaders(request)));
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
				json(response, 200, await store.backupTo(backupRoot, await registry.backupSnapshot(), identity.name));
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
				json(
					response,
					200,
					await store.restoreDrill(candidate, join(backupRoot, ".restore-drills"), identity.name),
				);
				return;
			}
			json(response, 405, { error: "method not allowed" });
		} catch (error) {
			if (error instanceof HttpError) {
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
	});
}

export function hashTeamToken(token: string): string {
	return hashTeamTokenValue(token);
}
