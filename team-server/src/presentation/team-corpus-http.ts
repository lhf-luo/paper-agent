import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import type {
	ArtifactManifest,
	DerivedRecord,
	PaperRecord,
	PaperVersion,
} from "../protocol/literature-types.ts";
import { validateTeamNamespace } from "../domain/team-corpus-validation.ts";
import type { TeamIdentity, TeamRole } from "../infrastructure/team-token-registry.ts";

export class HttpError extends Error {
	readonly status: 400 | 403 | 404 | 413;

	constructor(status: 400 | 403 | 404 | 413, message: string) {
		super(message);
		this.status = status;
	}
}

export function rejectRequest(message: string): never {
	throw new HttpError(400, message);
}

export function rejectForbidden(message: string): never {
	throw new HttpError(403, message);
}

export function permits(identity: TeamIdentity, role: TeamRole): boolean {
	return identity.roles.includes("admin") || identity.roles.includes(role);
}

export function json(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
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

export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
	const body = await readBody(request, maxBytes);
	if (body.length === 0) return {};
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		rejectRequest("request body must contain valid JSON");
	}
}

export function objectBody(value: unknown, message: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) rejectRequest(message);
	return value as Record<string, unknown>;
}

export function namespaceFromPath(pathname: string): { namespace: string; resource: string } | undefined {
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

export function isHttpUrl(value: string): boolean {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

const provenanceProviders = new Set([
	"arxiv",
	"acl_anthology",
	"openalex",
	"crossref",
	"semanticscholar",
	"dblp",
	"core",
	"opencitations",
	"unpaywall",
	"usenix",
	"exa",
	"local-pdf",
	"bibtex-import",
	"json-import",
	"zotero",
]);

export function validRecord(record: unknown): record is PaperRecord {
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

export function recordsBody(value: unknown): PaperRecord[] {
	const body = objectBody(value, "proposal request must be a JSON object");
	if (!Array.isArray(body.records)) rejectRequest("records[] is required");
	if (body.records.length > 500) rejectRequest("a proposal is limited to 500 records");
	if (!body.records.every(validRecord))
		rejectRequest(
			"every proposed record requires bounded text, public HTTP(S) links, valid provenance, and mergedFrom[]",
		);
	return body.records;
}

export function derivedRecordsBody(value: unknown): DerivedRecord[] {
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

export function artifactBody(value: unknown): { paperId: string; manifest: ArtifactManifest } {
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

export function reviewBody(
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

export function listParameter(url: URL, name: string): string[] | undefined {
	const values = url.searchParams
		.getAll(name)
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);
	return values.length ? [...new Set(values)] : undefined;
}

export function pagination(url: URL, maximum = 500): { offset: number; limit: number } {
	const offset = Number(url.searchParams.get("cursor") ?? 0);
	const requested = Number(url.searchParams.get("limit") ?? 100);
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(requested) || requested < 1)
		rejectRequest("cursor must be a non-negative integer and limit must be positive");
	return { offset, limit: Math.min(requested, maximum) };
}

export function namespaceRoot(root: string, namespace: string): string {
	const target = resolve(root, namespace);
	const path = relative(root, target);
	if (!path || path.startsWith("..") || isAbsolute(path))
		throw new Error("namespace resolves outside the configured team corpus root");
	return target;
}

export function versionHeaders(
	request: IncomingMessage,
): Omit<PaperVersion, "sha256" | "bytes" | "blobPath"> | undefined {
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
