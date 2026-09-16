import type { PaperRecord } from "../../literature/domain/literature-types.ts";
import { TeamAccessService } from "../../team/application/team-access-service.ts";
import { resolveTeamConnection, teamConnectionFingerprint } from "../../team/application/team-connection.ts";
import { TeamCorpusClient, TeamCorpusHttpError } from "../../team/application/team-corpus-client.ts";
import type { SharedReviewStatus, TeamReviewResource } from "../../team/domain/team-corpus-types.ts";
import { PaperAgentApplicationBase } from "./paper-agent-base.ts";

export abstract class PaperAgentTeamAccess extends PaperAgentApplicationBase {
	private teamAccessInstance?: TeamAccessService;
	get teamAccess(): TeamAccessService {
		this.teamAccessInstance ??= new TeamAccessService(this.projectRoot, this.consent);
		return this.teamAccessInstance;
	}
	protected async configuredTeam(expectedFingerprint?: string): Promise<{
		client: TeamCorpusClient;
		namespace: string;
		serverUrl: string;
		connectionFingerprint: string;
		source: string;
	}> {
		const connection = resolveTeamConnection(this.projectRoot);
		if (!connection) throw new Error("Team access is not configured");
		if (expectedFingerprint && expectedFingerprint !== teamConnectionFingerprint(connection))
			throw new TeamCorpusHttpError(409, "Team connection changed; prepare the operation again");
		return {
			client: new TeamCorpusClient({
				baseUrl: connection.serverUrl,
				token: connection.token,
				caPem: connection.caPem,
			}),
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

	/** Personal derived records available to propose to the team (Web submission block + tooling). */
	async listPersonalDerived(namespace = this.defaultNamespace): Promise<{
		entries: Array<{ key: string; operation: string; paperId: string; createdAt: string }>;
	}> {
		await this.initialize();
		const store = this.personalStore(namespace);
		const records = await store.listDerived();
		return {
			entries: records.map((record) => ({
				key: record.key,
				operation: record.operation,
				paperId: record.paperId,
				createdAt: record.createdAt,
			})),
		};
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
			const knowledgeOverview = async (resource: TeamReviewResource) => {
				const groups = await Promise.all([
					client.searchContent(namespace, { resource, limit: 25 }),
					capabilities.canReview
						? client.searchContent(namespace, { resource, pending: true, limit: 25 })
						: Promise.resolve({ entries: [] }),
				]);
				return {
					entries: groups
						.flatMap((group) => group.entries)
						.map((entry) => ({
							review: entry.review,
							version: entry.version,
							summaryOnly: true,
							snapshot: entry.page,
							record: entry.derived,
							paperId: entry.id,
							manifest: entry.artifact ? { pdfSha256: entry.artifact.pdfSha256 } : undefined,
							candidateCount: entry.artifact?.candidateCount,
							acquisitionCount: entry.artifact?.acquisitionCount,
						})),
				};
			};
			const permissionAware = async <T>(label: string, request: Promise<T>, fallback: T): Promise<T> => {
				try {
					return await request;
				} catch (error) {
					if (error instanceof TeamCorpusHttpError && [403, 404, 405, 501].includes(error.status)) {
						unavailable.push(label);
						return fallback;
					}
					throw error;
				}
			};
			const [stats, papers, pending, myProposals, derived, artifacts, pages, events, identities, maintenance] =
				await Promise.all([
					capabilities.canRead
						? permissionAware("stats", client.stats(namespace), {} as Record<string, unknown>)
						: Promise.resolve({} as Record<string, unknown>),
					// The overview only carries the first page of approved papers; the Web client pages with /api/team/search.
					capabilities.canRead
						? permissionAware("papers", client.search({ namespace, limit: 50 }), { hits: [] })
						: Promise.resolve({ hits: [] }),
					capabilities.canReview
						? permissionAware("pendingPapers", client.pendingPapers(namespace), { records: [] as PaperRecord[] })
						: Promise.resolve({ records: [] as PaperRecord[] }),
					capabilities.canContribute
						? permissionAware("myProposals", client.pendingPapers(namespace, undefined, { mine: true }), {
								records: [] as PaperRecord[],
							})
						: Promise.resolve({ records: [] as PaperRecord[] }),
					capabilities.canRead || capabilities.canReview
						? permissionAware("derived", knowledgeOverview("derived"), {
								entries: [],
							})
						: Promise.resolve({ entries: [] }),
					capabilities.canRead || capabilities.canReview
						? permissionAware("artifacts", knowledgeOverview("artifacts"), {
								entries: [],
							})
						: Promise.resolve({ entries: [] }),
					capabilities.canRead || capabilities.canReview
						? permissionAware("pages", knowledgeOverview("pages"), {
								entries: [],
							})
						: Promise.resolve({ entries: [] }),
					capabilities.canReview
						? permissionAware("events", client.events(namespace), { events: [] })
						: Promise.resolve({ events: [] }),
					capabilities.canAdmin
						? permissionAware("identities", client.listIdentities(), { identities: [] })
						: Promise.resolve({ identities: [] }),
					capabilities.canAdmin
						? permissionAware("maintenance", client.maintenance(namespace), {})
						: Promise.resolve({}),
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
				/** First page of approved papers; use `searchTeamLibrary` with a cursor to load more. */
				papers: papers.hits.map((hit) => hit.record),
				pendingPapers: pending.records,
				myProposals: myProposals.records,
				derived: derived.entries,
				artifacts: artifacts.entries,
				pages: pages.entries,
				events: events.events,
				identities: identities.identities,
				maintenance,
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
		authors?: string[];
		venues?: string[];
		types?: string[];
		statuses?: SharedReviewStatus[];
		openAccess?: boolean;
		topicIds?: string[];
		limit?: number;
		cursor?: string;
	}) {
		const { client, namespace } = await this.configuredTeam();
		return { namespace, ...(await client.search({ namespace, ...input })) };
	}

	async getTeamPaper(paperId: string): Promise<PaperRecord> {
		const { client, namespace } = await this.configuredTeam();
		return await client.getPaper(namespace, paperId);
	}

	/** Paged pending-review papers for the Web review workbench. */
	async listPendingTeamPapers(cursor?: string, limit = 10) {
		const { client, namespace } = await this.configuredTeam();
		return client.pendingPapers(namespace, cursor, { limit });
	}

	async readTeamBlob(sha256: string) {
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid attachment hash");
		const { client, namespace } = await this.configuredTeam();
		return client.downloadBlob(namespace, sha256);
	}

	async openTeamBlob(sha256: string) {
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid attachment hash");
		const { client, namespace } = await this.configuredTeam();
		return client.openBlob(namespace, sha256);
	}
}
