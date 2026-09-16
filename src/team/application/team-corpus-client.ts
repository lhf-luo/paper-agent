import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type {
	ArtifactManifest,
	CorpusSearchHit,
	DerivedRecord,
	PaperRecord,
	PaperVersion,
} from "../../literature/domain/literature-types.ts";
import type {
	SharedReviewStatus,
	TeamActor,
	TeamArtifactEntry,
	TeamAuditEvent,
	TeamCollaborationChange,
	TeamContentQuery,
	TeamContentRef,
	TeamContentSummary,
	TeamDerivedEntry,
	TeamDiscussion,
	TeamListPage,
	TeamNotification,
	TeamPageEntry,
	TeamReviewResource,
	TeamReviewSnapshot,
	TeamReviewVersions,
	TeamSubmission,
	TeamTopic,
	TeamTopicChange,
} from "../domain/team-corpus-types.ts";
import { validateTeamNamespace } from "../domain/team-corpus-validation.ts";
import type { PublicTeamIdentity, TeamIdentityAction, TeamIdentityInput } from "../domain/team-identity.ts";
import { teamFetch } from "../infrastructure/team-http-transport.ts";
import { resolveTeamConnection } from "./team-connection.ts";

function isLoopback(hostname: string): boolean {
	return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

export interface TeamCorpusConnection {
	baseUrl: string | URL;
	token: string;
	timeoutMs?: number;
	caPem?: string;
}

export function sanitizePaperRecordForTeamProposal(record: PaperRecord): PaperRecord {
	return {
		...record,
		// Personal-library categories are private organisation and their ids mean nothing to the team service,
		// which keeps its own categories as `TeamTopic` records. Strip them so they cannot travel upward and
		// later reappear in another member's personal library as dangling ids.
		collectionIds: undefined,
		curation: {
			tags: [...(record.curation?.tags ?? [])],
			userNotes: [],
		},
	};
}

export function sanitizeArtifactManifestForTeamProposal(manifest: ArtifactManifest): ArtifactManifest {
	const filename = (value: string) => value.split(/[\\/]/).at(-1) ?? value;
	return {
		...manifest,
		pdfPath: filename(manifest.pdfPath),
		candidates: manifest.candidates.map((candidate) => ({
			...candidate,
			sources: candidate.sources.map((source) => ({ ...source, context: source.context?.slice(0, 2000) })),
		})),
		acquisitions: manifest.acquisitions.map((snapshot) => ({
			...snapshot,
			localPath: undefined,
			metadataFile: snapshot.metadataFile
				? { ...snapshot.metadataFile, name: filename(snapshot.metadataFile.name) }
				: undefined,
			licenseFiles: snapshot.licenseFiles?.map(filename),
		})),
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
	private readonly caPem?: string;

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
		this.caPem = connection.caPem;
		if (this.baseUrl.username || this.baseUrl.password) throw new Error("Team URL cannot contain credentials");
	}

	private url(path: string): URL {
		const url = new URL(path, this.baseUrl);
		if (url.origin !== this.baseUrl.origin) throw new Error("Team request must remain on the configured origin");
		return url;
	}

	private fetch(url: URL, init: RequestInit): Promise<Response> {
		return teamFetch(url, init, this.caPem);
	}

	private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("accept", "application/json");
		headers.set("authorization", `Bearer ${this.token}`);
		if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
		const response = await this.fetch(this.url(path), {
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
		if (!response.ok) {
			throw new TeamCorpusHttpError(
				response.status,
				(body as { error?: string }).error ?? `Team corpus HTTP ${response.status}`,
			);
		}
		return body as T;
	}

	private namespacePath(namespace: string, resource: string): string {
		return `/v1/namespaces/${encodeURIComponent(validateTeamNamespace(namespace))}/${resource}`;
	}

	async searchContent(namespace: string, input: TeamContentQuery = {}): Promise<TeamListPage<TeamContentSummary>> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(input))
			if (value !== undefined) query.set(key === "query" ? "q" : key, String(value));
		return this.requestJson(this.namespacePath(namespace, `content?${query}`));
	}
	async readContent(
		namespace: string,
		ref: TeamContentRef,
		options: { pending?: boolean; version?: string } = {},
	): Promise<TeamReviewSnapshot> {
		const query = new URLSearchParams();
		if (options.pending) query.set("pending", "true");
		if (options.version) query.set("version", options.version);
		return this.requestJson(
			this.namespacePath(namespace, `content/${ref.resource}/${encodeURIComponent(ref.id)}?${query}`),
		);
	}
	async contributions(
		namespace: string,
		options: { mine?: boolean; status?: string; cursor?: string; limit?: number } = {},
	): Promise<TeamListPage<TeamSubmission>> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value));
		return this.requestJson(this.namespacePath(namespace, `contributions?${query}`));
	}
	async discussion(namespace: string, ref: TeamContentRef): Promise<TeamDiscussion> {
		return this.requestJson(
			this.namespacePath(namespace, `discussions/${ref.resource}/${encodeURIComponent(ref.id)}`),
		);
	}
	async changeCollaboration(namespace: string, input: TeamCollaborationChange): Promise<unknown> {
		return this.requestJson(this.namespacePath(namespace, "collaboration"), {
			method: "POST",
			body: JSON.stringify(input),
		});
	}
	async reviewers(namespace: string): Promise<{ entries: TeamActor[] }> {
		return this.requestJson(this.namespacePath(namespace, "reviewers"));
	}
	async notifications(
		namespace: string,
		cursor?: string,
		limit = 50,
	): Promise<TeamListPage<TeamNotification> & { unread: number }> {
		return this.requestJson(
			this.namespacePath(
				namespace,
				`notifications?${new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })}`,
			),
		);
	}
	async readNotifications(namespace: string, ids: string[]): Promise<{ read: number }> {
		return this.requestJson(this.namespacePath(namespace, "notifications/read"), {
			method: "POST",
			body: JSON.stringify({ ids }),
		});
	}
	async topics(namespace: string, cursor?: string, limit = 50): Promise<TeamListPage<TeamTopic>> {
		return this.requestJson(
			this.namespacePath(
				namespace,
				`topics?${new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })}`,
			),
		);
	}
	async changeTopic(namespace: string, input: TeamTopicChange): Promise<TeamTopic | { deleted: string }> {
		return this.requestJson(this.namespacePath(namespace, "topics"), { method: "POST", body: JSON.stringify(input) });
	}

	async whoAmI(): Promise<{ identity: PublicTeamIdentity }> {
		return this.requestJson("/v1/whoami");
	}

	async health(): Promise<{ ok: boolean; service: string; version: number }> {
		const response = await this.fetch(this.url("/health"), { signal: AbortSignal.timeout(this.timeoutMs) });
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
		statuses?: SharedReviewStatus[];
		openAccess?: boolean;
		/** Category ids (`TeamTopic`) to scope the search to. Results are the union of the listed categories. */
		topicIds?: string[];
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
		for (const status of input.statuses ?? []) query.append("status", status);
		for (const topicId of input.topicIds ?? []) query.append("topic", topicId);
		if (input.openAccess !== undefined) query.set("openAccess", String(input.openAccess));
		if (input.cursor !== undefined) query.set("cursor", input.cursor);
		if (input.limit !== undefined) query.set("limit", String(input.limit));
		return this.requestJson(`${this.namespacePath(input.namespace, "search")}?${query}`);
	}

	async getPaper(namespace: string, paperId: string): Promise<PaperRecord> {
		return this.requestJson(this.namespacePath(namespace, `papers/${encodeURIComponent(paperId)}`));
	}

	async listPaperVersions(namespace: string, paperId: string): Promise<{ versions: PaperVersion[] }> {
		return this.requestJson(this.namespacePath(namespace, `papers/${encodeURIComponent(paperId)}/versions`));
	}

	async pendingPapers(
		namespace: string,
		cursor?: string,
		options: { mine?: boolean; limit?: number } = {},
	): Promise<{ records: PaperRecord[]; nextCursor?: string }> {
		const query = new URLSearchParams();
		if (cursor) query.set("cursor", cursor);
		if (options.mine) query.set("mine", "true");
		if (options.limit) query.set("limit", String(options.limit));
		const suffix = query.size ? `?${query}` : "";
		return this.requestJson(`${this.namespacePath(namespace, "proposals")}${suffix}`);
	}

	async proposePapers(namespace: string, records: PaperRecord[], options: { topicIds?: string[] } = {}) {
		const topicIds = options.topicIds?.length ? [...new Set(options.topicIds)] : undefined;
		return this.requestJson<{ promoted: number; contributor: string; requestedTopicIds?: string[] }>(
			this.namespacePath(namespace, "proposals"),
			{
				method: "POST",
				body: JSON.stringify({
					records: records.map(sanitizePaperRecordForTeamProposal),
					// Categories travel as a request on the review envelope: only a reviewer may write them.
					...(topicIds ? { topicIds } : {}),
				}),
			},
		);
	}

	async withdrawPapers(
		namespace: string,
		paperIds: string[],
		expectedVersions?: TeamReviewVersions,
	): Promise<{ withdrawn: string[] }> {
		return this.requestJson(this.namespacePath(namespace, "proposals/withdraw"), {
			method: "POST",
			body: JSON.stringify({ paperIds, expectedVersions }),
		});
	}

	async previewReview(
		namespace: string,
		resource: TeamReviewResource,
		ids: string[],
	): Promise<{ entries: TeamReviewSnapshot[] }> {
		return this.requestJson(this.namespacePath(namespace, "reviews/preview"), {
			method: "POST",
			body: JSON.stringify({ resource, ids }),
		});
	}

	async reviewPapers(
		namespace: string,
		paperIds: string[],
		decision: "team-approved" | "team-rejected",
		reason?: string,
		expectedVersions?: TeamReviewVersions,
	) {
		return this.requestJson<{ reviewed: PaperRecord[] }>(this.namespacePath(namespace, "reviews"), {
			method: "POST",
			body: JSON.stringify({ paperIds, decision, reason, expectedVersions }),
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
		expectedVersions?: TeamReviewVersions,
	): Promise<{ entries: TeamDerivedEntry[] }> {
		return this.requestJson(this.namespacePath(namespace, "derived/reviews"), {
			method: "POST",
			body: JSON.stringify({ keys, decision, reason, expectedVersions }),
		});
	}

	async listArtifacts(namespace: string, includePending = false): Promise<{ entries: TeamArtifactEntry[] }> {
		return this.requestJson(`${this.namespacePath(namespace, "artifacts")}${includePending ? "?pending=true" : ""}`);
	}

	async listPages(
		namespace: string,
		options: { includePending?: boolean } = {},
	): Promise<{ entries: TeamPageEntry[] }> {
		return this.requestJson(
			`${this.namespacePath(namespace, "pages")}${options.includePending ? "?pending=true" : ""}`,
		);
	}

	async proposePages(namespace: string, records: TeamPageEntry["snapshot"][]): Promise<{ entries: TeamPageEntry[] }> {
		return this.requestJson(this.namespacePath(namespace, "pages"), {
			method: "POST",
			body: JSON.stringify({ records }),
		});
	}

	async reviewPages(
		namespace: string,
		keys: string[],
		decision: "team-approved" | "team-rejected",
		reason?: string,
		expectedVersions?: TeamReviewVersions,
	): Promise<{ entries: TeamPageEntry[] }> {
		return this.requestJson(this.namespacePath(namespace, "pages/reviews"), {
			method: "POST",
			body: JSON.stringify({ keys, decision, reason, expectedVersions }),
		});
	}

	async proposeArtifact(
		namespace: string,
		paperId: string,
		manifest: ArtifactManifest,
	): Promise<{ entry: TeamArtifactEntry }> {
		return this.requestJson(this.namespacePath(namespace, "artifacts"), {
			method: "POST",
			body: JSON.stringify({ paperId, manifest: sanitizeArtifactManifestForTeamProposal(manifest) }),
		});
	}

	async reviewArtifacts(
		namespace: string,
		paperIds: string[],
		decision: "team-approved" | "team-rejected",
		reason?: string,
		expectedVersions?: TeamReviewVersions,
	): Promise<{ entries: TeamArtifactEntry[] }> {
		return this.requestJson(this.namespacePath(namespace, "artifacts/reviews"), {
			method: "POST",
			body: JSON.stringify({ paperIds, decision, reason, expectedVersions }),
		});
	}

	async uploadBlob(
		namespace: string,
		sha256: string,
		data: Uint8Array | ReadableStream<Uint8Array>,
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
		const init: RequestInit & { duplex?: "half" } = {
			method: "PUT",
			headers,
			body: data as BodyInit,
			duplex: data instanceof Uint8Array ? undefined : "half",
			signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
		};
		const response = await this.fetch(this.url(this.namespacePath(namespace, `blobs/${sha256}`)), init);
		const body = (await response.json()) as { error?: string; sha256?: string; existed?: boolean };
		if (!response.ok) {
			throw new TeamCorpusHttpError(response.status, body.error ?? `Team corpus HTTP ${response.status}`);
		}
		return body;
	}

	async uploadBlobFile(
		namespace: string,
		sha256: string,
		path: string,
		version?: Omit<PaperVersion, "sha256" | "bytes" | "blobPath">,
	) {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		if (hash.digest("hex") !== sha256) throw new Error("The local PDF blob changed after confirmation");
		return this.uploadBlob(
			namespace,
			sha256,
			Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>,
			version,
		);
	}

	async openBlob(namespace: string, sha256: string): Promise<Response> {
		const response = await this.fetch(this.url(this.namespacePath(namespace, `blobs/${sha256}`)), {
			headers: { authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new TeamCorpusHttpError(response.status, `Team corpus HTTP ${response.status}`);
		}
		return response;
	}

	async downloadBlob(namespace: string, sha256: string): Promise<{ body: Uint8Array; contentType: string }> {
		const response = await this.fetch(this.url(this.namespacePath(namespace, `blobs/${sha256}`)), {
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
	async maintenance(namespace: string) {
		return this.requestJson<
			Record<string, { status: "succeeded" | "failed"; at: string; backupPath?: string; message?: string }>
		>(this.namespacePath(namespace, "maintenance"));
	}

	async restoreDrill(namespace: string, backupPath: string) {
		return this.requestJson<{
			validated: true;
			namespace: string;
			identityCount: number;
			stats: {
				recordCount: number;
				derivedCount: number;
				artifactCount: number;
				blobCount: number;
				blobBytes: number;
			};
		}>(this.namespacePath(namespace, "backups/drill"), {
			method: "POST",
			body: JSON.stringify({ backupPath }),
		});
	}

	async listIdentities(): Promise<{ identities: PublicTeamIdentity[] }> {
		return this.requestJson("/v1/admin/identities");
	}

	async createIdentity(input: TeamIdentityInput): Promise<{ token: string; identity: PublicTeamIdentity }> {
		return this.requestJson("/v1/admin/identities", { method: "POST", body: JSON.stringify(input) });
	}

	async changeIdentity(
		id: string,
		action: TeamIdentityAction,
		input: TeamIdentityInput = {},
	): Promise<{ token?: string; identity: PublicTeamIdentity }> {
		return this.requestJson(`/v1/admin/identities/${encodeURIComponent(id)}/${action}`, {
			method: "POST",
			body: JSON.stringify(input),
		});
	}
}

let configuredProjectRoot = process.cwd();

export function setTeamProjectRoot(projectRoot: string): void {
	configuredProjectRoot = projectRoot;
}

export function configuredTeamCorpusClient(): TeamCorpusClient {
	const connection = resolveTeamConnection(configuredProjectRoot);
	if (!connection) throw new Error("Team access is not configured");
	return new TeamCorpusClient({ baseUrl: connection.serverUrl, token: connection.token, caPem: connection.caPem });
}

export async function searchRemoteTeamCorpus(input: Parameters<TeamCorpusClient["search"]>[0]) {
	return configuredTeamCorpusClient().search(input);
}
