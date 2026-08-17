import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import { LiteratureStore, resolveCorpusRoot } from "../literature-store.ts";
import type {
	ArtifactManifest,
	CorpusSearchHit,
	DerivedRecord,
	PaperRecord,
	PaperVersion,
} from "../literature-types.ts";
import {
	OperationConsentManager,
	type OperationPlan,
	requestOperationAuthorization,
} from "../operation-consent.ts";
import { teamNamespacePattern, validateTeamNamespace } from "../team-corpus-validation.ts";
import type { TeamArtifactEntry, TeamAuditEvent, TeamDerivedEntry } from "../team-knowledge-store.ts";
import type { TeamRole } from "../team-token-registry.ts";

function isLoopback(hostname: string): boolean {
	return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

export interface TeamCorpusConnection {
	baseUrl: string | URL;
	token: string;
	timeoutMs?: number;
}

export function sanitizePaperRecordForTeamProposal(record: PaperRecord): PaperRecord {
	return {
		...record,
		curation: {
			tags: [...(record.curation?.tags ?? [])],
			userNotes: [],
		},
	};
}

export class TeamCorpusHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class TeamCorpusClient {
	readonly baseUrl: URL;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(connection: TeamCorpusConnection) {
		this.baseUrl = new URL(connection.baseUrl);
		if (
			this.baseUrl.protocol !== "https:" &&
			!(this.baseUrl.protocol === "http:" && isLoopback(this.baseUrl.hostname))
		) {
			throw new Error("Remote team corpus requires HTTPS; plain HTTP is allowed only for loopback development");
		}
		if (!connection.token) throw new Error("A team corpus bearer token is required");
		this.token = connection.token;
		this.timeoutMs = connection.timeoutMs ?? 30_000;
	}

	private url(path: string): URL {
		return new URL(path, this.baseUrl);
	}

	private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("accept", "application/json");
		headers.set("authorization", `Bearer ${this.token}`);
		if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
		const response = await fetch(this.url(path), {
			...init,
			headers,
			signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
		});
		const raw = await response.text();
		let body: unknown = {};
		try {
			body = raw ? JSON.parse(raw) : {};
		} catch {
			if (!response.ok) throw new TeamCorpusHttpError(response.status, `Team corpus HTTP ${response.status}`);
			throw new Error("Team corpus returned invalid JSON");
		}
		if (!response.ok)
			throw new TeamCorpusHttpError(
				response.status,
				(body as { error?: string }).error ?? `Team corpus HTTP ${response.status}`,
			);
		return body as T;
	}

	private namespacePath(namespace: string, resource: string): string {
		return `/v1/namespaces/${encodeURIComponent(validateTeamNamespace(namespace))}/${resource}`;
	}

	async whoAmI(): Promise<{ identity: { name: string; roles: TeamRole[] } }> {
		return this.requestJson("/v1/whoami");
	}

	async health(): Promise<{ ok: boolean; service: string; version: number }> {
		const response = await fetch(this.url("/health"), { signal: AbortSignal.timeout(this.timeoutMs) });
		if (!response.ok) throw new TeamCorpusHttpError(response.status, `Team corpus health HTTP ${response.status}`);
		return response.json() as Promise<{ ok: boolean; service: string; version: number }>;
	}

	async search(input: {
		namespace: string;
		query?: string;
		yearFrom?: number;
		yearTo?: number;
		authors?: string[];
		venues?: string[];
		types?: string[];
		openAccess?: boolean;
		cursor?: string;
		limit?: number;
	}): Promise<{ hits: CorpusSearchHit[]; nextCursor?: string }> {
		const query = new URLSearchParams();
		if (input.query) query.set("q", input.query);
		if (input.yearFrom !== undefined) query.set("yearFrom", String(input.yearFrom));
		if (input.yearTo !== undefined) query.set("yearTo", String(input.yearTo));
		for (const author of input.authors ?? []) query.append("author", author);
		for (const venue of input.venues ?? []) query.append("venue", venue);
		for (const type of input.types ?? []) query.append("type", type);
		if (input.openAccess !== undefined) query.set("openAccess", String(input.openAccess));
		if (input.cursor !== undefined) query.set("cursor", input.cursor);
		if (input.limit !== undefined) query.set("limit", String(input.limit));
		return this.requestJson(`${this.namespacePath(input.namespace, "search")}?${query}`);
	}

	async pendingPapers(namespace: string, cursor?: string): Promise<{ records: PaperRecord[]; nextCursor?: string }> {
		const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
		return this.requestJson(`${this.namespacePath(namespace, "proposals")}${query}`);
	}

	async proposePapers(namespace: string, records: PaperRecord[]) {
		return this.requestJson<{ promoted: number; contributor: string }>(this.namespacePath(namespace, "proposals"), {
			method: "POST",
			body: JSON.stringify({ records: records.map(sanitizePaperRecordForTeamProposal) }),
		});
	}

	async reviewPapers(
		namespace: string,
		paperIds: string[],
		decision: "team-approved" | "team-rejected",
		reason?: string,
	) {
		return this.requestJson<{ reviewed: PaperRecord[] }>(this.namespacePath(namespace, "reviews"), {
			method: "POST",
			body: JSON.stringify({ paperIds, decision, reason }),
		});
	}

	async stats(namespace: string) {
		return this.requestJson<Record<string, unknown>>(this.namespacePath(namespace, "stats"));
	}

	async audit(namespace: string) {
		return this.requestJson<Record<string, unknown>>(this.namespacePath(namespace, "audit"));
	}

	async events(
		namespace: string,
		cursor?: string,
		limit = 100,
	): Promise<{ events: TeamAuditEvent[]; nextCursor?: string }> {
		const query = new URLSearchParams({ limit: String(limit) });
		if (cursor) query.set("cursor", cursor);
		return this.requestJson(`${this.namespacePath(namespace, "events")}?${query}`);
	}

	async listDerived(
		namespace: string,
		options: { paperId?: string; includePending?: boolean } = {},
	): Promise<{ entries: TeamDerivedEntry[] }> {
		const query = new URLSearchParams();
		if (options.paperId) query.set("paperId", options.paperId);
		if (options.includePending) query.set("pending", "true");
		return this.requestJson(`${this.namespacePath(namespace, "derived")}?${query}`);
	}

	async proposeDerived(namespace: string, records: DerivedRecord[]): Promise<{ entries: TeamDerivedEntry[] }> {
		return this.requestJson(this.namespacePath(namespace, "derived"), {
			method: "POST",
			body: JSON.stringify({ records }),
		});
	}

	async reviewDerived(
		namespace: string,
		keys: string[],
		decision: "team-approved" | "team-rejected",
		reason?: string,
	): Promise<{ entries: TeamDerivedEntry[] }> {
		return this.requestJson(this.namespacePath(namespace, "derived/reviews"), {
			method: "POST",
			body: JSON.stringify({ keys, decision, reason }),
		});
	}

	async listArtifacts(namespace: string, includePending = false): Promise<{ entries: TeamArtifactEntry[] }> {
		return this.requestJson(`${this.namespacePath(namespace, "artifacts")}${includePending ? "?pending=true" : ""}`);
	}

	async proposeArtifact(
		namespace: string,
		paperId: string,
		manifest: ArtifactManifest,
	): Promise<{ entry: TeamArtifactEntry }> {
		return this.requestJson(this.namespacePath(namespace, "artifacts"), {
			method: "POST",
			body: JSON.stringify({ paperId, manifest }),
		});
	}

	async reviewArtifacts(
		namespace: string,
		paperIds: string[],
		decision: "team-approved" | "team-rejected",
		reason?: string,
	): Promise<{ entries: TeamArtifactEntry[] }> {
		return this.requestJson(this.namespacePath(namespace, "artifacts/reviews"), {
			method: "POST",
			body: JSON.stringify({ paperIds, decision, reason }),
		});
	}

	async uploadBlob(
		namespace: string,
		sha256: string,
		data: Uint8Array,
		version?: Omit<PaperVersion, "sha256" | "bytes" | "blobPath">,
	) {
		const headers = new Headers({
			"content-type": version?.contentType ?? "application/octet-stream",
			authorization: `Bearer ${this.token}`,
		});
		if (version) {
			headers.set("x-paper-id", version.paperId);
			headers.set("x-source-url", version.sourceUrl);
			headers.set("x-final-url", version.finalUrl);
			headers.set("x-retrieved-at", version.retrievedAt);
		}
		const response = await fetch(this.url(this.namespacePath(namespace, `blobs/${sha256}`)), {
			method: "PUT",
			headers,
			body: data as BodyInit,
			signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
		});
		const body = (await response.json()) as { error?: string; sha256?: string; existed?: boolean };
		if (!response.ok)
			throw new TeamCorpusHttpError(response.status, body.error ?? `Team corpus HTTP ${response.status}`);
		return body;
	}

	async downloadBlob(namespace: string, sha256: string): Promise<{ body: Uint8Array; contentType: string }> {
		const response = await fetch(this.url(this.namespacePath(namespace, `blobs/${sha256}`)), {
			headers: { authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
		});
		if (!response.ok) throw new TeamCorpusHttpError(response.status, `Team corpus HTTP ${response.status}`);
		return {
			body: new Uint8Array(await response.arrayBuffer()),
			contentType: response.headers.get("content-type") ?? "application/octet-stream",
		};
	}

	async backup(namespace: string) {
		return this.requestJson<{ backupPath: string }>(this.namespacePath(namespace, "backups"), {
			method: "POST",
			body: "{}",
		});
	}

	async restoreDrill(namespace: string, backupPath: string) {
		return this.requestJson<{
			validated: true;
			namespace: string;
			identityCount: number;
			stats: { recordCount: number; derivedCount: number; artifactCount: number; blobCount: number; blobBytes: number };
		}>(this.namespacePath(namespace, "backups/drill"), {
			method: "POST",
			body: JSON.stringify({ backupPath }),
		});
	}

	async listIdentities(): Promise<{
		identities: Array<{
			name: string;
			roles: TeamRole[];
			createdAt?: string;
			rotatedAt?: string;
			revokedAt?: string;
		}>;
	}> {
		return this.requestJson("/v1/admin/identities");
	}

	async rotateIdentity(
		name: string,
		roles?: TeamRole[],
	): Promise<{ token: string; identity: { name: string; roles: TeamRole[] } }> {
		return this.requestJson(`/v1/admin/identities/${encodeURIComponent(name)}/rotate`, {
			method: "POST",
			body: JSON.stringify({ roles }),
		});
	}

	async revokeIdentity(name: string): Promise<{ identity: { name: string; roles: TeamRole[]; revokedAt?: string } }> {
		return this.requestJson(`/v1/admin/identities/${encodeURIComponent(name)}/revoke`, {
			method: "POST",
			body: "{}",
		});
	}
}

function environmentClient(): TeamCorpusClient {
	const value = process.env.PAPER_AGENT_TEAM_SERVER_URL;
	const token = process.env.PAPER_AGENT_TEAM_TOKEN;
	if (!value || !token) throw new Error("PAPER_AGENT_TEAM_SERVER_URL and PAPER_AGENT_TEAM_TOKEN are required");
	return new TeamCorpusClient({ baseUrl: value, token });
}

export async function searchRemoteTeamCorpus(input: Parameters<TeamCorpusClient["search"]>[0]) {
	return environmentClient().search(input);
}

export function registerTeamCorpusClientTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "manage_team_literature_server",
		label: "Manage team literature server",
		description:
			"Search a centrally deployed team corpus, propose privacy-scrubbed personal records, review proposals, inspect audit state, or trigger an administrator backup. Credentials come only from environment variables.",
		promptSnippet: "Use the authenticated shared team literature service",
		promptGuidelines: [
			"Search may reuse team records, but records remain discovery evidence until primary sources are opened.",
			"Propose from personal scope; the service removes personal notes and screening opinions before team storage.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("search"),
				Type.Literal("propose"),
				Type.Literal("review"),
				Type.Literal("audit"),
				Type.Literal("stats"),
				Type.Literal("backup"),
			]),
			namespace: Type.Optional(Type.String({ pattern: teamNamespacePattern, maxLength: 64 })),
			query: Type.Optional(Type.String()),
			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			authors: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			venues: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			publication_types: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			open_access: Type.Optional(Type.Boolean()),
			cursor: Type.Optional(Type.String({ pattern: "^\\d+$" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			personal_namespace: Type.Optional(Type.String()),
			personal_corpus_root: Type.Optional(Type.String()),
			review_decision: Type.Optional(Type.Union([Type.Literal("team-approved"), Type.Literal("team-rejected")])),
			review_reason: Type.Optional(Type.String()),
		}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const namespace = validateTeamNamespace(params.namespace ?? "default");
				const client = environmentClient();
				const authorize = async (plan: OperationPlan) => {
					if (!ctx.hasUI) {
						throw new Error("Team write operations require an interactive user confirmation");
					}
					const consent = new OperationConsentManager({
						auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
					});
					const authorization = await requestOperationAuthorization(
						consent,
						plan,
						(prepared) =>
							ctx.ui.confirm(
								"Write to the team knowledge service?",
								[
									prepared.summary,
									`Manifest: ${prepared.manifestFingerprint}`,
									...prepared.targets.map((target) => `- [${target.risk ?? "medium"}] ${target.value}`),
								].join("\n"),
							),
						"interactive-user",
					);
					await authorization.manager.consume(authorization.grant, plan);
				};
			if (params.action === "search") {
				const result = await client.search({
					namespace,
					query: params.query,
					yearFrom: params.year_from,
					yearTo: params.year_to,
					authors: params.authors,
					venues: params.venues,
					types: params.publication_types,
					openAccess: params.open_access,
					cursor: params.cursor,
					limit: params.limit,
				});
				return {
					content: [
						{
							type: "text",
							text: `Remote team corpus matches: ${result.hits.length}; next cursor: ${result.nextCursor ?? "none"}`,
						},
					],
					details: { namespace, ...result },
				};
			}
			if (params.action === "propose") {
				const personalNamespace = params.personal_namespace ?? "default";
				const store = new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", personalNamespace, params.personal_corpus_root),
					"personal",
					personalNamespace,
				);
				const requested = params.paper_ids
					? await Promise.all(params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })))
					: undefined;
				const missing = requested?.filter((item) => !item.record).map((item) => item.id) ?? [];
				if (missing.length)
					throw new Error(`personal corpus does not contain requested paper ids: ${missing.join(", ")}`);
					const records = (requested
						? requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record))
						: await store.listPapers()
					).map(sanitizePaperRecordForTeamProposal);
					await authorize({
						kind: "team-proposal",
						summary: `Propose ${records.length} privacy-scrubbed personal paper record(s) to the team service`,
						actor: "interactive-user",
						targets: records.map((record) => ({ label: record.title.slice(0, 120), value: record.id, risk: "high" })),
						details: {
							namespace,
							personalNamespace,
							privacy: "Personal notes, screening decisions, and previous team review state are removed before transfer.",
							records,
						},
					});
					const result = await client.proposePapers(namespace, records);
				return {
					content: [{ type: "text", text: `Proposed ${records.length} records to ${namespace}` }],
					details: result,
				};
			}
			if (params.action === "review") {
					if (!params.paper_ids?.length || !params.review_decision)
						throw new Error("review requires paper_ids and review_decision");
					await authorize({
						kind: "team-review",
						summary: `${params.review_decision === "team-approved" ? "Approve" : "Reject"} ${params.paper_ids.length} team paper proposal(s)`,
						actor: "interactive-user",
						targets: params.paper_ids.map((id) => ({ label: "Team paper", value: id, risk: "high" })),
						details: { namespace, decision: params.review_decision, reason: params.review_reason },
					});
					const result = await client.reviewPapers(
					namespace,
					params.paper_ids,
					params.review_decision,
					params.review_reason,
				);
				return {
					content: [{ type: "text", text: `Reviewed ${params.paper_ids.length} team records` }],
					details: result,
				};
			}
			if (params.action === "audit" || params.action === "stats") {
				const result = params.action === "audit" ? await client.audit(namespace) : await client.stats(namespace);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			}
				await authorize({
					kind: "backup-restore",
					summary: `Create a server-side backup of team namespace ${namespace}`,
					actor: "interactive-user",
					targets: [{ label: "Team namespace", value: namespace, risk: "medium" }],
					details: { namespace, action: "backup" },
				});
				const result = await client.backup(namespace);
			return { content: [{ type: "text", text: "Team corpus backup completed" }], details: result };
		},
	});
}
