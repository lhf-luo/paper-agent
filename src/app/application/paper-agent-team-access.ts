import type { PaperRecord } from "../../literature/domain/literature-types.ts";
import { TeamCorpusClient, TeamCorpusHttpError } from "../../team/application/team-corpus-client.ts";
import { resolveTeamConnection, teamConnectionFingerprint } from "../../team/application/team-connection.ts";
import { TeamAccessService } from "../../team/application/team-access-service.ts";
import { PaperAgentApplicationBase } from "./paper-agent-base.ts";

export abstract class PaperAgentTeamAccess extends PaperAgentApplicationBase {
	private teamAccessInstance?: TeamAccessService;
	get teamAccess(): TeamAccessService {
		this.teamAccessInstance ??= new TeamAccessService(this.projectRoot, this.consent);
		return this.teamAccessInstance;
	}
	protected async configuredTeam(): Promise<{
		client: TeamCorpusClient;
		namespace: string;
		serverUrl: string;
		connectionFingerprint: string;
		source: string;
	}> {
		const connection = resolveTeamConnection(this.projectRoot);
		if (!connection) throw new Error("Team access is not configured");
		return {
			client: new TeamCorpusClient({ baseUrl: connection.serverUrl, token: connection.token, caPem: connection.caPem }),
			namespace: connection.namespace,
			serverUrl: connection.serverUrl,
			connectionFingerprint: teamConnectionFingerprint(connection),
			source: connection.source,
		};
	}

	async listAvailablePdfs(namespace = this.defaultNamespace): Promise<
		Array<{
			paperId: string;
			title: string;
			sha256: string;
			blobPath: string;
			sourceUrl?: string;
			bytes: number;
			contentType: string;
		}>
	> {
		await this.initialize();
		const store = this.personalStore(namespace);
		await store.initialize();
		const results: Array<{
			paperId: string;
			title: string;
			sha256: string;
			blobPath: string;
			sourceUrl?: string;
			bytes: number;
			contentType: string;
			hasPdf: boolean;
		}> = [];
		for (const record of await store.listPapers()) {
			const versions = await store.listPaperVersions(record.id);
			const preferred = versions.find((version) => version.isPreferred) ?? versions[0];
			results.push({
				paperId: record.id,
				title: record.title,
				sha256: preferred?.sha256 ?? "",
				blobPath: preferred?.blobPath ?? "",
				sourceUrl: preferred?.sourceUrl,
				bytes: preferred?.bytes ?? 0,
				contentType: preferred?.contentType ?? "",
				hasPdf: Boolean(preferred),
			});
		}
		return results.sort((left, right) => left.title.localeCompare(right.title));
	}

	async teamOverview() {
		const connection = resolveTeamConnection(this.projectRoot);
		if (!connection)
			return { configured: false, connected: false, reason: "Team knowledge service is not configured" };
		try {
			const { client, namespace, serverUrl } = await this.configuredTeam();
			const [health, who] = await Promise.all([client.health(), client.whoAmI()]);
			const roles = who.identity.roles;
			const capabilities = {
				canRead: roles.includes("admin") || roles.includes("reader"),
				canContribute: roles.includes("admin") || roles.includes("contributor"),
				canReview: roles.includes("admin") || roles.includes("reviewer"),
				canAdmin: roles.includes("admin"),
			};
			const unavailable: string[] = [];
			const permissionAware = async <T>(label: string, request: Promise<T>, fallback: T): Promise<T> => {
				try {
					return await request;
				} catch (error) {
					if (error instanceof TeamCorpusHttpError && error.status === 403) {
						unavailable.push(label);
						return fallback;
					}
					throw error;
				}
			};
			const [stats, papers, pending, derived, artifacts, events, identities] = await Promise.all([
				capabilities.canRead
					? permissionAware("stats", client.stats(namespace), {} as Record<string, unknown>)
					: Promise.resolve({} as Record<string, unknown>),
				capabilities.canRead
					? permissionAware("papers", client.search({ namespace, limit: 300 }), { hits: [] })
					: Promise.resolve({ hits: [] }),
				capabilities.canReview
					? permissionAware("pendingPapers", client.pendingPapers(namespace), { records: [] as PaperRecord[] })
					: Promise.resolve({ records: [] as PaperRecord[] }),
				capabilities.canRead || capabilities.canReview
					? permissionAware("derived", client.listDerived(namespace, { includePending: capabilities.canReview }), {
							entries: [],
						})
					: Promise.resolve({ entries: [] }),
				capabilities.canRead || capabilities.canReview
					? permissionAware("artifacts", client.listArtifacts(namespace, capabilities.canReview), { entries: [] })
					: Promise.resolve({ entries: [] }),
				capabilities.canReview
					? permissionAware("events", client.events(namespace), { events: [] })
					: Promise.resolve({ events: [] }),
				capabilities.canAdmin
					? permissionAware("identities", client.listIdentities(), { identities: [] })
					: Promise.resolve({ identities: [] }),
			]);
			return {
				configured: true,
				connected: true,
				source: connection.source,
				serverUrl,
				namespace,
				health,
				identity: who.identity,
				capabilities,
				unavailable,
				stats,
				papers: papers.hits.map((hit) => hit.record),
				pendingPapers: pending.records,
				derived: derived.entries,
				artifacts: artifacts.entries,
				events: events.events,
				identities: identities.identities,
			};
		} catch (error) {
			return {
				configured: true,
				connected: false,
				serverUrl: connection.serverUrl,
				namespace: connection.namespace,
				source: connection.source,
				reason: error instanceof Error ? error.message : String(error),
				status: error instanceof TeamCorpusHttpError ? error.status : undefined,
			};
		}
	}

	async searchTeamLibrary(input: {
		query?: string;
		yearFrom?: number;
		yearTo?: number;
		limit?: number;
		cursor?: string;
	}) {
		const { client, namespace } = await this.configuredTeam();
		return { namespace, ...(await client.search({ namespace, ...input })) };
	}
}
