import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	loadPaperAgentConfig,
	probeModelToolCalling,
	resolvePaperAgentConfigPath,
	savePaperAgentConfig,
	supportsAutomaticToolCallingProbe,
	validatePaperAgentConfig,
} from "./app-config.ts";
import { acquireArtifacts, artifactAcquisitionPlan, assertArtifactSelection } from "./artifact-acquisition.ts";
import { discoverArtifactsFromPdf, sha256File } from "./artifact-discovery.ts";
import {
	ArtifactEvaluationReviewService,
	type ArtifactReviewSubmissionInput,
} from "./artifact-evaluation-review.ts";
import {
	collectLiterature,
	corpusAnnotationPlan,
	corpusExportPlan,
	expandLiteratureQueries,
} from "./collection-tools.ts";
import { type CommandExecutor, NodeCommandExecutor } from "./command-executor.ts";
import { type BackgroundJob, PersistentJobQueue } from "./job-queue.ts";
import {
	downloadLiteraturePdfs,
	type LiteraturePdfDownloadRequest,
	literaturePdfDownloadPlan,
} from "./literature-download.ts";
import { literatureProviderDefinitions } from "./literature-providers.ts";
import { LiteratureStore, resolveCorpusRoot } from "./literature-store.ts";
import type {
	ArtifactManifest,
	LiteratureProvider,
	PaperRecord,
	ScreeningStatus,
	SearchFilters,
} from "./literature-types.ts";
import { corpusUpsertPlan, persistPaperRecords, runAuthorizedMutation } from "./literature-write.ts";
import {
	authorizeOperationExecution,
	type ConfirmationGrant,
	OperationConsentManager,
	type OperationExecutionPermit,
	type OperationPlan,
	type PreparedOperation,
} from "./operation-consent.ts";
import { analyzePdfForLibrary } from "./pdf-analysis.ts";
import { PdfAnnotationStore } from "./pdf-annotation-store.ts";
import type { PdfBox } from "./pdf-asset-tools.ts";
import { validatePdfPath } from "./pdf-tools.ts";
import {
	type ResearchRecord,
	type ResearchRecordKind,
	ResearchWorkspace,
	validateResearchRecord,
} from "./research-workspace.ts";
import { sanitizePaperRecordForTeamProposal, TeamCorpusClient, TeamCorpusHttpError } from "./team-corpus-client.ts";
import type { TeamRole } from "./team-token-registry.ts";

export interface PaperAgentApplicationConfig {
	projectRoot: string;
	dataRoot?: string;
	corpusRoot?: string;
	defaultNamespace?: string;
	executor?: CommandExecutor;
	jobConcurrency?: number;
}

export interface LiteratureSearchJobInput {
	query: string;
	queryExpansions?: string[];
	providers?: LiteratureProvider[];
	filters?: SearchFilters;
	pagesPerProvider?: number;
	maxResultsPerProvider?: number;
	namespace?: string;
	reuseCorpus?: boolean;
	checkpointId?: string;
}

export interface PdfDownloadPreparationInput {
	paperIds?: string[];
	maxFiles?: number;
	maxMegabytesPerFile?: number;
	concurrency?: number;
	namespace?: string;
}

export interface ArtifactAcquisitionPreparationInput {
	pdfPath: string;
	candidateIds?: string[];
	maxArtifacts?: number;
	maxMegabytesPerArtifact?: number;
}

interface AuthorizedPdfDownloadJob {
	executionPermit: OperationExecutionPermit;
	request: LiteraturePdfDownloadRequest;
	namespace: string;
}

interface AuthorizedArtifactJob {
	executionPermit: OperationExecutionPermit;
	pdfPath: string;
	candidateIds?: string[];
	maxArtifacts: number;
	maxBytesPerArtifact: number;
}

interface CorpusImportInput {
	searchJobId: string;
	paperIds?: string[];
	namespace?: string;
}

interface AuthorizedCorpusImportJob extends CorpusImportInput {
	executionPermit: OperationExecutionPermit;
}

export interface TeamPaperProposalInput {
	paperIds: string[];
	personalNamespace?: string;
}

export interface TeamReviewInput {
	resource: "papers" | "derived" | "artifacts";
	ids: string[];
	decision: "team-approved" | "team-rejected";
	reason?: string;
}

export interface TeamTokenChangeInput {
	action: "rotate" | "revoke";
	name: string;
	roles?: TeamRole[];
}

export interface TeamArtifactProposalInput {
	artifactJobId: string;
	paperId: string;
	personalNamespace?: string;
}

export interface TeamBlobUploadInput {
	paperId: string;
	sha256: string;
	personalNamespace?: string;
}

export interface TeamRestoreDrillInput {
	backupPath: string;
}

export interface PdfAssetCorrectionInput {
	analysisJobId: string;
	assetId: string;
	correctedRegion: PdfBox;
	note?: string;
	author?: string;
}

export interface PersonalCorpusAnnotationInput {
	paperIds: string[];
	namespace?: string;
	author?: string;
	tags?: string[];
	note?: string;
	screeningStatus?: ScreeningStatus;
	screeningReason?: string;
}

export type PersonalCorpusExportFormat = "markdown" | "csv" | "bibtex" | "json";

export interface PersonalCorpusExportInput {
	namespace?: string;
	paperIds?: string[];
	format: PersonalCorpusExportFormat;
	filename?: string;
}

function personalExportFilename(format: PersonalCorpusExportFormat, requested?: string): string {
	const extension = format === "markdown" ? "md" : format === "bibtex" ? "bib" : format;
	const filename = requested?.trim() || `literature-export.${extension}`;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(filename)) {
		throw new Error("Export filename must use 1-64 letters, numbers, dots, underscores, or hyphens");
	}
	return filename;
}

export class PaperAgentApplication {
	readonly projectRoot: string;
	readonly dataRoot: string;
	readonly corpusRoot: string;
	readonly defaultNamespace: string;
	readonly jobs: PersistentJobQueue;
	readonly consent: OperationConsentManager;
	readonly executor: CommandExecutor;
	readonly artifactEvaluation: ArtifactEvaluationReviewService;
	private initialized = false;

	constructor(config: PaperAgentApplicationConfig) {
		this.projectRoot = resolve(config.projectRoot);
		this.dataRoot = resolve(config.dataRoot ?? join(this.projectRoot, ".paper-agent"));
		this.corpusRoot = resolve(config.corpusRoot ?? join(this.dataRoot, "corpus"));
		this.defaultNamespace = config.defaultNamespace ?? "default";
		this.executor = config.executor ?? new NodeCommandExecutor();
		this.consent = new OperationConsentManager({
			auditPath: join(this.dataRoot, "audit", "operations.jsonl"),
			signingKeyPath: join(this.dataRoot, "runtime", "operation-signing.key"),
		});
		this.artifactEvaluation = new ArtifactEvaluationReviewService({
			projectRoot: this.projectRoot,
			dataRoot: this.dataRoot,
			executor: this.executor,
			consent: this.consent,
		});
		this.jobs = new PersistentJobQueue(join(this.dataRoot, "runtime", "jobs.sqlite"), config.jobConcurrency ?? 2);
		this.registerJobHandlers();
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.jobs.initialize();
		this.initialized = true;
	}

	async close(): Promise<void> {
		await this.jobs.stop();
		this.initialized = false;
	}

	personalStore(namespace = this.defaultNamespace): LiteratureStore {
		return new LiteratureStore(
			resolveCorpusRoot(this.projectRoot, "personal", namespace, this.corpusRoot),
			"personal",
			namespace,
		);
	}

	teamStore(namespace = this.defaultNamespace): LiteratureStore {
		return new LiteratureStore(
			resolveCorpusRoot(this.projectRoot, "team", namespace, this.corpusRoot),
			"team",
			namespace,
		);
	}

	async status() {
		await this.initialize();
		const namespaces = await this.listNamespaces("personal");
		const records = await this.personalStore().listPapers();
		return {
			ok: true,
			projectRoot: this.projectRoot,
			dataRoot: this.dataRoot,
			corpusRoot: this.corpusRoot,
			defaultNamespace: this.defaultNamespace,
			personalNamespaces: namespaces,
			defaultRecordCount: records.length,
			jobs: {
				queued: this.jobs.list({ status: "queued" }).length,
				running: this.jobs.list({ status: "running" }).length,
				failed: this.jobs.list({ status: "failed" }).length,
			},
		};
	}

	async configuration() {
		const config = await loadPaperAgentConfig(this.projectRoot);
		return {
			...config,
			path: resolvePaperAgentConfigPath(this.projectRoot),
			model: config.model
				? {
						...config.model,
						credentialsAvailable: Boolean(
							config.model.apiKey ??
								(config.model.apiKeyEnvironmentVariable
									? process.env[config.model.apiKeyEnvironmentVariable]
									: undefined),
						),
					}
				: undefined,
			team: config.team
				? {
						...config.team,
						credentialsAvailable: Boolean(process.env[config.team.tokenEnvironmentVariable]),
					}
				: undefined,
		};
	}

	providerCatalog() {
		const latestHealth = new Map<string, unknown>();
		for (const job of this.jobs.list({ limit: 200 })) {
			if (
				job.type !== "literature-search" ||
				job.status !== "succeeded" ||
				!job.result ||
				typeof job.result !== "object"
			)
				continue;
			const health = (job.result as { run?: { providerHealth?: Record<string, unknown> } }).run?.providerHealth;
			for (const [provider, snapshot] of Object.entries(health ?? {}))
				if (!latestHealth.has(provider)) latestHealth.set(provider, snapshot);
		}
		return literatureProviderDefinitions.map((definition) => ({
			id: definition.id,
			label: definition.label,
			description: definition.description,
			queryMode: definition.queryMode,
			requiresEnvironmentVariable: definition.requiresEnvironmentVariable,
			credentialsAvailable: definition.requiresEnvironmentVariable
				? Boolean(process.env[definition.requiresEnvironmentVariable])
				: true,
			lastHealth: latestHealth.get(definition.id),
		}));
	}

	private async configuredTeam(): Promise<{
		client: TeamCorpusClient;
		namespace: string;
		serverUrl: string;
	}> {
		const config = await loadPaperAgentConfig(this.projectRoot);
		if (!config.team) throw new Error("Team knowledge service is not configured");
		const token = process.env[config.team.tokenEnvironmentVariable];
		if (!token)
			throw new Error(`Team token environment variable is missing: ${config.team.tokenEnvironmentVariable}`);
		return {
			client: new TeamCorpusClient({ baseUrl: config.team.serverUrl, token }),
			namespace: config.team.namespace,
			serverUrl: config.team.serverUrl,
		};
	}

	async teamOverview() {
		const config = await loadPaperAgentConfig(this.projectRoot);
		if (!config.team)
			return { configured: false, connected: false, reason: "Team knowledge service is not configured" };
		const tokenAvailable = Boolean(process.env[config.team.tokenEnvironmentVariable]);
		if (!tokenAvailable) {
			return {
				configured: true,
				connected: false,
				serverUrl: config.team.serverUrl,
				namespace: config.team.namespace,
				tokenEnvironmentVariable: config.team.tokenEnvironmentVariable,
				reason: `Environment variable ${config.team.tokenEnvironmentVariable} is not set`,
			};
		}
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
				serverUrl: config.team.serverUrl,
				namespace: config.team.namespace,
				tokenEnvironmentVariable: config.team.tokenEnvironmentVariable,
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

	private async teamPaperProposalPlan(
		input: TeamPaperProposalInput,
	): Promise<{ records: PaperRecord[]; plan: OperationPlan }> {
		if (!input.paperIds.length || input.paperIds.length > 500)
			throw new Error("Select between 1 and 500 personal papers");
		const namespace = input.personalNamespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const requested = await Promise.all(input.paperIds.map(async (id) => ({ id, record: await store.getPaper(id) })));
		const missing = requested.filter((item) => !item.record).map((item) => item.id);
		if (missing.length) throw new Error(`Personal corpus does not contain: ${missing.join(", ")}`);
		const records = requested
			.map((item) => item.record)
			.filter((record): record is PaperRecord => Boolean(record))
			.map(sanitizePaperRecordForTeamProposal);
		const team = await this.configuredTeam();
		const preview = records;
		return {
			records,
			plan: {
				kind: "team-proposal",
				summary: `Propose ${records.length} personal paper record(s) to the team knowledge base`,
				actor: "local-user",
				targets: records.map((record) => ({
					label: record.title.slice(0, 120),
					value: record.id,
					risk: "medium" as const,
				})),
				details: {
					serverUrl: team.serverUrl,
					teamNamespace: team.namespace,
					personalNamespace: namespace,
					privacy: "Personal notes and screening decisions are removed; tags and source provenance remain.",
					preview,
				},
			},
		};
	}

	async prepareTeamPaperProposal(input: TeamPaperProposalInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamPaperProposalPlan(input)).plan);
	}

	async proposeTeamPapers(input: TeamPaperProposalInput, grant: ConfirmationGrant) {
		const prepared = await this.teamPaperProposalPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam();
		return client.proposePapers(namespace, prepared.records);
	}

	private async teamReviewPlan(input: TeamReviewInput): Promise<OperationPlan> {
		if (!input.ids.length || input.ids.length > 500) throw new Error("Select between 1 and 500 team entries");
		if (input.reason && input.reason.length > 10_000) throw new Error("Review reason is too long");
		const team = await this.configuredTeam();
		return {
			kind: "team-review",
			summary: `${input.decision === "team-approved" ? "Approve" : "Reject"} ${input.ids.length} team ${input.resource} entr${input.ids.length === 1 ? "y" : "ies"}`,
			actor: "local-user",
			targets: input.ids.map((id) => ({ label: input.resource, value: id, risk: "high" as const })),
			details: { serverUrl: team.serverUrl, namespace: team.namespace, ...input },
		};
	}

	async prepareTeamReview(input: TeamReviewInput): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamReviewPlan(input));
	}

	async reviewTeamEntries(input: TeamReviewInput, grant: ConfirmationGrant) {
		await this.consent.consume(grant, await this.teamReviewPlan(input));
		const { client, namespace } = await this.configuredTeam();
		if (input.resource === "papers") return client.reviewPapers(namespace, input.ids, input.decision, input.reason);
		if (input.resource === "derived") return client.reviewDerived(namespace, input.ids, input.decision, input.reason);
		return client.reviewArtifacts(namespace, input.ids, input.decision, input.reason);
	}

	private async teamBackupPlan(): Promise<OperationPlan> {
		const team = await this.configuredTeam();
		return {
			kind: "backup-restore",
			summary: "Create a server-side backup of the team knowledge namespace",
			actor: "local-user",
			targets: [{ label: "Team namespace", value: `${team.serverUrl}/${team.namespace}`, risk: "medium" }],
			details: { action: "backup", serverUrl: team.serverUrl, namespace: team.namespace },
		};
	}

	async prepareTeamBackup(): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamBackupPlan());
	}

	async backupTeam(grant: ConfirmationGrant) {
		await this.consent.consume(grant, await this.teamBackupPlan());
		const { client, namespace } = await this.configuredTeam();
		return client.backup(namespace);
	}

	private async teamRestoreDrillPlan(input: TeamRestoreDrillInput): Promise<OperationPlan> {
		if (typeof input.backupPath !== "string" || !input.backupPath.trim() || input.backupPath.length > 4_000) {
			throw new Error("A bounded backupPath is required");
		}
		const team = await this.configuredTeam();
		return {
			kind: "backup-restore",
			summary: "Run a non-destructive restore drill for a team backup bundle",
			actor: "local-user",
			targets: [{ label: "Backup bundle", value: input.backupPath.trim(), risk: "high" }],
			details: { action: "restore-drill", serverUrl: team.serverUrl, namespace: team.namespace },
		};
	}

	async prepareTeamRestoreDrill(input: TeamRestoreDrillInput): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamRestoreDrillPlan(input));
	}

	async drillTeamRestore(input: TeamRestoreDrillInput, grant: ConfirmationGrant) {
		await this.consent.consume(grant, await this.teamRestoreDrillPlan(input));
		const { client, namespace } = await this.configuredTeam();
		return client.restoreDrill(namespace, input.backupPath.trim());
	}

	private async teamArtifactProposalPlan(input: TeamArtifactProposalInput) {
		if (!input.artifactJobId?.trim() || input.artifactJobId.length > 200)
			throw new Error("artifactJobId is required");
		if (!input.paperId?.trim() || input.paperId.length > 500) throw new Error("paperId is required");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const paper = await this.personalStore(personalNamespace).getPaper(input.paperId);
		if (!paper) throw new Error("The artifact manifest must be linked to a paper in the selected personal corpus");
		const job = this.jobs.get(input.artifactJobId);
		if (!job || job.status !== "succeeded" || !job.result || typeof job.result !== "object") {
			throw new Error("A completed artifact discovery or acquisition job is required");
		}
		const manifest =
			job.type === "artifact-discovery"
				? (job.result as ArtifactManifest)
				: job.type === "artifact-acquisition"
					? (job.result as { manifest?: ArtifactManifest }).manifest
					: undefined;
		if (!manifest?.pdfSha256 || !Array.isArray(manifest.candidates) || !Array.isArray(manifest.acquisitions)) {
			throw new Error("The selected job does not contain a valid artifact manifest");
		}
		const team = await this.configuredTeam();
		return {
			manifest,
			plan: {
				kind: "team-proposal" as const,
				summary: `Propose the artifact manifest for ${paper.title} to the team knowledge base`,
				actor: "local-user",
				targets: [{ label: "Artifact manifest", value: input.paperId, risk: "high" as const }],
				details: {
					serverUrl: team.serverUrl,
					teamNamespace: team.namespace,
					personalNamespace,
					paper: { id: paper.id, title: paper.title },
					manifest,
				},
			},
		};
	}

	async prepareTeamArtifactProposal(input: TeamArtifactProposalInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamArtifactProposalPlan(input)).plan);
	}

	async proposeTeamArtifact(input: TeamArtifactProposalInput, grant: ConfirmationGrant) {
		const prepared = await this.teamArtifactProposalPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam();
		return client.proposeArtifact(namespace, input.paperId, prepared.manifest);
	}

	private async teamBlobUploadPlan(input: TeamBlobUploadInput) {
		if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("sha256 is invalid");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const versions = await this.personalStore(personalNamespace).listPaperVersions(input.paperId);
		const version = versions.find((candidate) => candidate.sha256 === input.sha256.toLowerCase());
		if (!version) throw new Error("The selected PDF version is not present in the personal corpus");
		const team = await this.configuredTeam();
		return {
			version,
			plan: {
				kind: "team-proposal" as const,
				summary: "Upload one content-addressed personal PDF version to the team knowledge base",
				actor: "local-user",
				targets: [{ label: "PDF blob", value: `${input.paperId}/${version.sha256}`, risk: "high" as const }],
				details: {
					serverUrl: team.serverUrl,
					teamNamespace: team.namespace,
					personalNamespace,
					paperId: input.paperId,
					sha256: version.sha256,
					bytes: version.bytes,
					contentType: version.contentType,
				},
			},
		};
	}

	async prepareTeamBlobUpload(input: TeamBlobUploadInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamBlobUploadPlan(input)).plan);
	}

	async uploadTeamBlob(input: TeamBlobUploadInput, grant: ConfirmationGrant) {
		const prepared = await this.teamBlobUploadPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const body = await this.readPdfVersionBlob(input.paperId, prepared.version.sha256, input.personalNamespace);
		if (createHash("sha256").update(body).digest("hex") !== prepared.version.sha256) {
			throw new Error("The local PDF blob changed after confirmation");
		}
		const { client, namespace } = await this.configuredTeam();
		const { sha256: _sha256, bytes: _bytes, blobPath: _blobPath, ...version } = prepared.version;
		return client.uploadBlob(namespace, prepared.version.sha256, body, version);
	}

	private async teamTokenPlan(input: TeamTokenChangeInput): Promise<OperationPlan> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(input.name)) throw new Error("Team identity name is invalid");
		if (
			input.roles &&
			(!input.roles.length ||
				!input.roles.every((role) => ["reader", "contributor", "reviewer", "admin"].includes(role)))
		)
			throw new Error("Team roles are invalid");
		const team = await this.configuredTeam();
		return {
			kind: "team-token-management",
			summary: `${input.action === "rotate" ? "Create or rotate" : "Revoke"} team identity token`,
			actor: "local-user",
			targets: [{ label: "Team identity", value: input.name, risk: "high" }],
			details: { action: input.action, roles: input.roles, serverUrl: team.serverUrl },
		};
	}

	async prepareTeamTokenChange(input: TeamTokenChangeInput): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamTokenPlan(input));
	}

	async changeTeamToken(input: TeamTokenChangeInput, grant: ConfirmationGrant) {
		await this.consent.consume(grant, await this.teamTokenPlan(input));
		const { client } = await this.configuredTeam();
		return input.action === "rotate"
			? client.rotateIdentity(input.name, input.roles)
			: client.revokeIdentity(input.name);
	}

	researchWorkspace(namespace = this.defaultNamespace): ResearchWorkspace {
		const safeNamespace = this.personalStore(namespace).namespace;
		return new ResearchWorkspace(join(this.dataRoot, "research", safeNamespace));
	}

	async researchOverview(namespace = this.defaultNamespace) {
		const workspace = this.researchWorkspace(namespace);
		const [records, audit] = await Promise.all([workspace.list(), workspace.audit(100)]);
		return {
			namespace,
			root: workspace.root,
			records,
			audit,
			counts: {
				skimCards: records.filter((record) => record.kind === "skim-card").length,
				comparisonMatrices: records.filter((record) => record.kind === "comparison-matrix").length,
				evidenceGraphs: records.filter((record) => record.kind === "evidence-graph").length,
				aiDrafts: records.filter(
					(record) => record.authorship.type === "ai-assisted" && !record.authorship.humanReviewed,
				).length,
			},
		};
	}

	private researchWritePlan(
		input: ResearchRecord,
		namespace = this.defaultNamespace,
	): { record: ResearchRecord; plan: OperationPlan } {
		const record = validateResearchRecord(input);
		return {
			record,
			plan: {
				kind: "research-memory-write",
				summary: `${record.revision ? "Update" : "Create"} ${record.kind} in the persistent research workspace`,
				actor: record.authorship.author,
				targets: [
					{
						label: record.kind,
						value: `${namespace}/${record.id}`,
						risk: record.authorship.type === "human" ? "medium" : "low",
					},
				],
				details: {
					namespace,
					record,
					evidenceRule:
						"AI-assisted content cannot overwrite a human-authored record or change a human conclusion.",
				},
			},
		};
	}

	async prepareResearchWrite(input: ResearchRecord, namespace?: string): Promise<PreparedOperation> {
		return this.consent.prepare(this.researchWritePlan(input, namespace).plan);
	}

	async writeResearchRecord(input: ResearchRecord, grant: ConfirmationGrant, namespace?: string) {
		const prepared = this.researchWritePlan(input, namespace);
		await this.consent.consume(grant, prepared.plan);
		return this.researchWorkspace(namespace).save(prepared.record);
	}

	private async researchSharePlan(kind: ResearchRecordKind, id: string, namespace = this.defaultNamespace) {
		const workspace = this.researchWorkspace(namespace);
		const record = await workspace.get(kind, id);
		if (!record) throw new Error(`Research record not found: ${kind}/${id}`);
		if (!record.authorship.humanReviewed)
			throw new Error("Only human-reviewed research records may be proposed to the team knowledge base");
		const derived = workspace.toDerivedRecord(record);
		const team = await this.configuredTeam();
		return {
			derived,
			plan: {
				kind: "team-proposal" as const,
				summary: "Propose a human-reviewed research record to the team knowledge base",
				actor: record.authorship.author,
				targets: [{ label: record.kind, value: derived.key, risk: "high" as const }],
				details: {
					serverUrl: team.serverUrl,
					teamNamespace: team.namespace,
					personalNamespace: namespace,
					derived,
				},
			},
		};
	}

	async prepareResearchShare(kind: ResearchRecordKind, id: string, namespace?: string): Promise<PreparedOperation> {
		return this.consent.prepare((await this.researchSharePlan(kind, id, namespace)).plan);
	}

	async shareResearchRecord(kind: ResearchRecordKind, id: string, grant: ConfirmationGrant, namespace?: string) {
		const prepared = await this.researchSharePlan(kind, id, namespace);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace: teamNamespace } = await this.configuredTeam();
		return client.proposeDerived(teamNamespace, [prepared.derived]);
	}

	private pdfAnnotationStore(): PdfAnnotationStore {
		return new PdfAnnotationStore(join(this.dataRoot, "pdf-annotations"));
	}

	private pdfCorrectionPlan(input: PdfAssetCorrectionInput) {
		const job = this.jobs.get(input.analysisJobId);
		if (
			!job ||
			job.type !== "pdf-analysis" ||
			job.status !== "succeeded" ||
			!job.result ||
			typeof job.result !== "object"
		) {
			throw new Error("Completed PDF analysis job was not found");
		}
		const result = job.result as {
			pdfPath: string;
			pdfSha256: string;
			pages: Array<{ page: number; width: number; height: number }>;
			assets: Array<{ id: string; page: number; candidateRegion: PdfBox }>;
		};
		const asset = result.assets.find((candidate) => candidate.id === input.assetId);
		if (!asset) throw new Error("The selected asset is not present in the analysis job");
		const page = result.pages.find((candidate) => candidate.page === asset.page);
		const box = input.correctedRegion;
		if (
			!page ||
			![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
			box.x < 0 ||
			box.y < 0 ||
			box.width <= 0 ||
			box.height <= 0 ||
			box.x + box.width > page.width + 0.5 ||
			box.y + box.height > page.height + 0.5
		) {
			throw new Error("Corrected asset region must fit within the physical PDF page");
		}
		const correction = {
			pdfSha256: result.pdfSha256,
			assetId: asset.id,
			page: asset.page,
			originalRegion: asset.candidateRegion,
			correctedRegion: { ...box },
			note: input.note,
			author: input.author?.trim() || "local-user",
		};
		return {
			correction,
			plan: {
				kind: "pdf-annotation-write" as const,
				summary: `Save a manual crop correction for ${asset.id}`,
				actor: correction.author,
				targets: [{ label: "PDF asset", value: `${result.pdfPath}#${asset.id}`, risk: "medium" as const }],
				details: {
					analysisJobId: input.analysisJobId,
					pdfSha256: result.pdfSha256,
					page: asset.page,
					originalRegion: asset.candidateRegion,
					correctedRegion: correction.correctedRegion,
					note: correction.note,
				},
			},
		};
	}

	async preparePdfAssetCorrection(input: PdfAssetCorrectionInput): Promise<PreparedOperation> {
		return this.consent.prepare(this.pdfCorrectionPlan(input).plan);
	}

	async savePdfAssetCorrection(input: PdfAssetCorrectionInput, grant: ConfirmationGrant) {
		const prepared = this.pdfCorrectionPlan(input);
		await this.consent.consume(grant, prepared.plan);
		return this.pdfAnnotationStore().save(prepared.correction);
	}

	async artifactJobDetails(jobId: string) {
		const job = this.jobs.get(jobId);
		if (
			!job ||
			job.type !== "artifact-acquisition" ||
			job.status !== "succeeded" ||
			!job.result ||
			typeof job.result !== "object"
		) {
			throw new Error("Completed artifact acquisition job was not found");
		}
		const result = job.result as { manifest?: ArtifactManifest; root?: string; manifestPath?: string };
		if (!result.manifest || !result.root) throw new Error("Artifact job result is incomplete");
		const root = resolve(result.root);
		const tree: Array<{ path: string; type: "file" | "directory"; bytes?: number }> = [];
		const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
		while (pending.length && tree.length < 1_500) {
			const current = pending.shift();
			if (!current) break;
			for (const entry of await readdir(current.path, { withFileTypes: true }).catch(() => [])) {
				if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
				const path = join(current.path, entry.name);
				const relativePath = relative(root, path).replaceAll("\\", "/");
				if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
				if (entry.isDirectory()) {
					tree.push({ path: relativePath, type: "directory" });
					if (current.depth < 6) pending.push({ path, depth: current.depth + 1 });
				} else if (entry.isFile()) {
					tree.push({ path: relativePath, type: "file", bytes: (await stat(path)).size });
				}
				if (tree.length >= 1_500) break;
			}
		}
		return { ...result, root, tree, truncated: tree.length >= 1_500 };
	}

	private configurationWritePlan(value: unknown) {
		const config = validatePaperAgentConfig(value, this.projectRoot);
		return {
			config,
			plan: {
				kind: "configuration-write" as const,
				summary: "Update local Paper Agent configuration",
				actor: "local-user",
				targets: [
					{
						label: "Configuration file",
						value: resolvePaperAgentConfigPath(this.projectRoot),
						risk: "medium" as const,
					},
					{ label: "Personal namespace", value: config.storage.defaultNamespace, risk: "low" as const },
					...(config.model
						? [
								{
									label: "Model endpoint",
									value: `${config.model.providerId}/${config.model.modelId}`,
									risk: "medium" as const,
								},
							]
						: []),
					...(config.team
						? [
								{
									label: "Team service",
									value: `${config.team.serverUrl}/${config.team.namespace}`,
									risk: "medium" as const,
								},
							]
						: []),
				],
				details: { config },
			},
		};
	}

	async prepareConfigurationWrite(value: unknown): Promise<PreparedOperation> {
		return this.consent.prepare(this.configurationWritePlan(value).plan);
	}

	async writeConfiguration(value: unknown, grant: ConfirmationGrant) {
		const prepared = this.configurationWritePlan(value);
		await this.consent.consume(grant, prepared.plan);
		const saved = await savePaperAgentConfig(this.projectRoot, prepared.config);
		return {
			...saved,
			restartRequired:
				saved.config.storage.dataRoot !== this.dataRoot ||
				saved.config.storage.corpusRoot !== this.corpusRoot ||
				saved.config.storage.defaultNamespace !== this.defaultNamespace,
		};
	}

	private async modelProbePlan() {
		const config = await loadPaperAgentConfig(this.projectRoot);
		if (!config.model) throw new Error("Configure a model endpoint before running the tool-calling probe");
		if (!supportsAutomaticToolCallingProbe(config.model.api)) {
			throw new Error(
				`Automatic probing is available only for openai-completions and openai-responses. Verify ${config.model.api} from a Pi agent session with a real tool-using task.`,
			);
		}
		return {
			config,
			plan: {
				kind: "external-api-probe" as const,
				summary: "Send one small tool-calling capability request",
				actor: "local-user",
				targets: [
					{ label: "Provider", value: config.model.baseUrl, risk: "medium" as const },
					{ label: "Model", value: config.model.modelId, risk: "low" as const },
					{
						label: "Probe result configuration",
						value: resolvePaperAgentConfigPath(this.projectRoot),
						risk: "medium" as const,
					},
				],
				details: {
					api: config.model.api,
					modelId: config.model.modelId,
					purpose:
						"Verify structured function/tool calling; the request may consume a small amount of provider quota",
					persistProbeResult: true,
				},
			},
		};
	}

	async prepareModelProbe(): Promise<PreparedOperation> {
		return this.consent.prepare((await this.modelProbePlan()).plan);
	}

	async runModelProbe(grant: ConfirmationGrant) {
		const prepared = await this.modelProbePlan();
		await this.consent.consume(grant, prepared.plan);
		const result = await probeModelToolCalling(prepared.config.model!);
		prepared.config.model!.toolCallingProbe = result;
		if (result.supported) prepared.config.model!.toolCallingVerifiedAt = result.checkedAt;
		await savePaperAgentConfig(this.projectRoot, prepared.config);
		return result;
	}

	async listNamespaces(scope: "personal" | "team"): Promise<string[]> {
		const root = join(this.corpusRoot, scope);
		try {
			return (await readdir(root, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async searchPersonalLibrary(input: {
		query?: string;
		namespace?: string;
		yearFrom?: number;
		yearTo?: number;
		tags?: string[];
		screeningStatuses?: ScreeningStatus[];
		limit?: number;
	}) {
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		return {
			namespace,
			corpusPath: store.root,
			hits: await store.searchPapers({
				query: input.query,
				yearFrom: input.yearFrom,
				yearTo: input.yearTo,
				tags: input.tags,
				screeningStatuses: input.screeningStatuses,
				limit: input.limit ?? 100,
				readOnly: true,
			}),
		};
	}

	async paperDetails(id: string, namespace = this.defaultNamespace) {
		const store = this.personalStore(namespace);
		const paper = await store.getPaper(id);
		if (!paper) return undefined;
		return {
			paper,
			versions: await store.listPaperVersions(id),
			derived: await store.listDerived({ paperId: id }),
		};
	}

	private async personalAnnotationOperation(input: PersonalCorpusAnnotationInput) {
		if (!Array.isArray(input.paperIds) || input.paperIds.length < 1 || input.paperIds.length > 500) {
			throw new Error("Select between 1 and 500 personal papers");
		}
		const paperIds = [...new Set(input.paperIds.map((id) => id.trim()))];
		if (paperIds.some((id) => !id || id.length > 500)) throw new Error("Personal paper ids are invalid");
		const author = input.author?.trim() || "local-user";
		if (author.length > 200) throw new Error("Annotation author is too long");
		const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
		if (tags.length > 50 || tags.some((tag) => tag.length > 100)) {
			throw new Error("Annotations may contain at most 50 tags of 100 characters or fewer");
		}
		const note = input.note?.trim() || undefined;
		if (note && note.length > 20_000) throw new Error("Annotation note is too long");
		const screeningReason = input.screeningReason?.trim() || undefined;
		if (screeningReason && screeningReason.length > 10_000) throw new Error("Screening reason is too long");
		if (
			input.screeningStatus !== undefined &&
			!["unreviewed", "include", "exclude", "maybe"].includes(input.screeningStatus)
		) {
			throw new Error("Screening status is invalid");
		}
		if (!tags.length && !note && !input.screeningStatus) {
			throw new Error("Add at least one tag, note, or screening status");
		}
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const requested = await Promise.all(paperIds.map(async (id) => ({ id, record: await store.getPaper(id) })));
		const missing = requested.filter((item) => !item.record).map((item) => item.id);
		if (missing.length) throw new Error(`Personal corpus does not contain: ${missing.join(", ")}`);
		const records = requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record));
		const annotation = {
			author,
			tags: tags.length ? tags : undefined,
			note,
			screeningStatus: input.screeningStatus,
			screeningReason,
		};
		return { namespace, store, records, annotation, plan: corpusAnnotationPlan(store, records, annotation) };
	}

	async preparePersonalAnnotation(input: PersonalCorpusAnnotationInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.personalAnnotationOperation(input)).plan);
	}

	async annotatePersonalPapers(input: PersonalCorpusAnnotationInput, grant: ConfirmationGrant) {
		const prepared = await this.personalAnnotationOperation(input);
		const updated = await runAuthorizedMutation({ manager: this.consent, grant }, prepared.plan, async () => {
			const values: PaperRecord[] = [];
			for (const record of prepared.records) {
				values.push(await prepared.store.annotatePaper(record.id, prepared.annotation));
			}
			return values;
		});
		return { namespace: prepared.namespace, updated, count: updated.length };
	}

	private async personalExportOperation(input: PersonalCorpusExportInput) {
		if (!["markdown", "csv", "bibtex", "json"].includes(input.format)) {
			throw new Error("Export format must be markdown, csv, bibtex, or json");
		}
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		let records: PaperRecord[];
		if (input.paperIds?.length) {
			if (input.paperIds.length > 1_000) throw new Error("Select at most 1000 papers for one export");
			const paperIds = [...new Set(input.paperIds.map((id) => id.trim()))];
			const requested = await Promise.all(paperIds.map(async (id) => ({ id, record: await store.getPaper(id) })));
			const missing = requested.filter((item) => !item.record).map((item) => item.id);
			if (missing.length) throw new Error(`Personal corpus does not contain: ${missing.join(", ")}`);
			records = requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record));
		} else {
			records = await store.listPapers();
		}
		if (!records.length) throw new Error("The selected personal corpus export is empty");
		const filename = personalExportFilename(input.format, input.filename);
		return { namespace, store, records, filename, plan: corpusExportPlan(store, input.format, filename, records) };
	}

	async preparePersonalExport(input: PersonalCorpusExportInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.personalExportOperation(input)).plan);
	}

	async exportPersonalCorpus(input: PersonalCorpusExportInput, grant: ConfirmationGrant) {
		const prepared = await this.personalExportOperation(input);
		const path = await runAuthorizedMutation({ manager: this.consent, grant }, prepared.plan, () =>
			prepared.store.export(input.format, prepared.filename, prepared.records),
		);
		return {
			namespace: prepared.namespace,
			format: input.format,
			filename: prepared.filename,
			path,
			count: prepared.records.length,
		};
	}

	async readPersonalExport(filename: string, namespace = this.defaultNamespace): Promise<Buffer> {
		const safeFilename = personalExportFilename(
			filename.toLowerCase().endsWith(".bib")
				? "bibtex"
				: filename.toLowerCase().endsWith(".csv")
					? "csv"
					: filename.toLowerCase().endsWith(".json")
						? "json"
						: "markdown",
			filename,
		);
		const store = this.personalStore(namespace);
		const root = resolve(store.root, "exports");
		const path = resolve(root, safeFilename);
		const relativePath = relative(root, path);
		if (relativePath.startsWith("..") || isAbsolute(relativePath))
			throw new Error("Export path is outside the corpus");
		return readFile(path);
	}

	async enqueueLiteratureSearch(input: LiteratureSearchJobInput): Promise<BackgroundJob> {
		await this.initialize();
		const config = await loadPaperAgentConfig(this.projectRoot);
		return this.jobs.enqueue(
			"literature-search",
			{
				...input,
				query: input.query.trim(),
				queryExpansions: input.queryExpansions ?? config.search.queryExpansions,
				providers: input.providers ?? (config.search.providers as LiteratureProvider[]),
				pagesPerProvider: input.pagesPerProvider ?? config.search.pagesPerProvider,
				maxResultsPerProvider: input.maxResultsPerProvider ?? config.search.maxResultsPerProvider,
				namespace: input.namespace ?? config.storage.defaultNamespace ?? this.defaultNamespace,
				reuseCorpus: input.reuseCorpus ?? config.search.reuseCorpus,
			},
			{ maxAttempts: 2 },
		);
	}

	async enqueuePdfAnalysis(input: { pdfPath: string; refine?: boolean; ocr?: boolean }): Promise<BackgroundJob> {
		await this.initialize();
		return this.jobs.enqueue("pdf-analysis", input);
	}

	async enqueueArtifactDiscovery(input: { pdfPath: string }): Promise<BackgroundJob> {
		await this.initialize();
		return this.jobs.enqueue("artifact-discovery", input);
	}

	async retryJob(id: string): Promise<BackgroundJob> {
		await this.initialize();
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Background job not found: ${id}`);
		if (!["literature-search", "pdf-analysis", "artifact-discovery"].includes(job.type)) {
			throw new Error(
				"Only read-only search, PDF analysis, and artifact discovery jobs may be retried without a new confirmation",
			);
		}
		if (job.type === "literature-search") {
			const input = job.input as LiteratureSearchJobInput;
			return this.jobs.retry(id, { ...input, checkpointId: input.checkpointId ?? job.id });
		}
		return this.jobs.retry(id);
	}

	async preparePdfDownload(input: PdfDownloadPreparationInput): Promise<PreparedOperation> {
		await this.initialize();
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const request: LiteraturePdfDownloadRequest = {
			paperIds: input.paperIds,
			maxFiles: input.maxFiles ?? 20,
			maxBytesPerFile: (input.maxMegabytesPerFile ?? 50) * 1024 * 1024,
			concurrency: input.concurrency ?? 3,
		};
		return this.consent.prepare(await literaturePdfDownloadPlan(store, request));
	}

	async prepareArtifactAcquisition(
		input: ArtifactAcquisitionPreparationInput,
	): Promise<{ prepared: PreparedOperation; manifest: ArtifactManifest }> {
		await this.initialize();
		const manifest = await discoverArtifactsFromPdf(this.executor, input.pdfPath);
		const unknownIds = (input.candidateIds ?? []).filter(
			(id) => !manifest.candidates.some((candidate) => candidate.id === id),
		);
		if (unknownIds.length) throw new Error(`Unknown artifact candidate ids: ${unknownIds.join(", ")}`);
		assertArtifactSelection(manifest, input.candidateIds);
		const plan = artifactAcquisitionPlan(manifest, {
			candidateIds: input.candidateIds,
			maxArtifacts: input.maxArtifacts ?? 10,
			maxBytesPerArtifact: (input.maxMegabytesPerArtifact ?? 50) * 1024 * 1024,
		});
		return { prepared: await this.consent.prepare(plan), manifest };
	}

	async prepareCorpusImport(input: CorpusImportInput): Promise<PreparedOperation> {
		await this.initialize();
		const records = this.recordsFromSearchJob(input.searchJobId, input.paperIds);
		return this.consent.prepare(corpusUpsertPlan(this.personalStore(input.namespace), records));
	}

	async confirmOperation(operationId: string, manifestFingerprint: string): Promise<ConfirmationGrant> {
		return this.consent.confirm(operationId, manifestFingerprint, "local-user");
	}

	async enqueueAuthorizedPdfDownload(
		input: PdfDownloadPreparationInput,
		grant: ConfirmationGrant,
	): Promise<BackgroundJob> {
		await this.initialize();
		const namespace = input.namespace ?? this.defaultNamespace;
		const request: LiteraturePdfDownloadRequest = {
			paperIds: input.paperIds,
			maxFiles: input.maxFiles ?? 20,
			maxBytesPerFile: (input.maxMegabytesPerFile ?? 50) * 1024 * 1024,
			concurrency: input.concurrency ?? 3,
		};
		const executionPermit = await authorizeOperationExecution(
			{ manager: this.consent, grant },
			await literaturePdfDownloadPlan(this.personalStore(namespace), request),
		);
		const jobInput: AuthorizedPdfDownloadJob = {
			executionPermit,
			namespace,
			request,
		};
		return this.jobs.enqueue("pdf-download", jobInput);
	}

	async enqueueAuthorizedArtifactAcquisition(
		input: ArtifactAcquisitionPreparationInput,
		grant: ConfirmationGrant,
	): Promise<BackgroundJob> {
		await this.initialize();
		const manifest = await discoverArtifactsFromPdf(this.executor, input.pdfPath);
		const unknownIds = (input.candidateIds ?? []).filter(
			(id) => !manifest.candidates.some((candidate) => candidate.id === id),
		);
		if (unknownIds.length) throw new Error(`Unknown artifact candidate ids: ${unknownIds.join(", ")}`);
		assertArtifactSelection(manifest, input.candidateIds);
		const maxArtifacts = input.maxArtifacts ?? 10;
		const maxBytesPerArtifact = (input.maxMegabytesPerArtifact ?? 50) * 1024 * 1024;
		const executionPermit = await authorizeOperationExecution(
			{ manager: this.consent, grant },
			artifactAcquisitionPlan(manifest, {
				candidateIds: input.candidateIds,
				maxArtifacts,
				maxBytesPerArtifact,
			}),
		);
		const jobInput: AuthorizedArtifactJob = {
			executionPermit,
			pdfPath: input.pdfPath,
			candidateIds: input.candidateIds,
			maxArtifacts,
			maxBytesPerArtifact,
		};
		return this.jobs.enqueue("artifact-acquisition", jobInput);
	}

	async enqueueAuthorizedCorpusImport(input: CorpusImportInput, grant: ConfirmationGrant): Promise<BackgroundJob> {
		await this.initialize();
		const records = this.recordsFromSearchJob(input.searchJobId, input.paperIds);
		const executionPermit = await authorizeOperationExecution(
			{ manager: this.consent, grant },
			corpusUpsertPlan(this.personalStore(input.namespace), records),
		);
		return this.jobs.enqueue("corpus-import", { ...input, executionPermit } satisfies AuthorizedCorpusImportJob);
	}

	async readPdfVersionBlob(paperId: string, sha256: string, namespace = this.defaultNamespace): Promise<Buffer> {
		const versions = await this.personalStore(namespace).listPaperVersions(paperId);
		const version = versions.find((item) => item.sha256 === sha256);
		if (!version) throw new Error("PDF version was not found in the selected corpus");
		const expectedRoot = resolve(this.personalStore(namespace).root);
		const blobPath = resolve(version.blobPath);
		const relativeBlobPath = relative(expectedRoot, blobPath);
		if (relativeBlobPath.startsWith("..") || isAbsolute(relativeBlobPath)) {
			throw new Error("PDF blob resolves outside the selected corpus");
		}
		return readFile(blobPath);
	}

	async readLocalPdf(inputPath: string): Promise<{ path: string; body: Buffer }> {
		const path = await validatePdfPath(inputPath, this.projectRoot);
		return { path, body: await readFile(path) };
	}

	async artifactEvaluationQueue() {
		return this.artifactEvaluation.list();
	}

	async artifactEvaluationDetails(slug: string) {
		return this.artifactEvaluation.detail(slug);
	}

	async readArtifactEvaluationPdf(slug: string) {
		return this.artifactEvaluation.readPdf(slug);
	}

	async prepareArtifactEvaluationReview(slug: string, input: ArtifactReviewSubmissionInput): Promise<PreparedOperation> {
		return this.artifactEvaluation.prepare(slug, input);
	}

	async saveArtifactEvaluationReview(
		slug: string,
		input: ArtifactReviewSubmissionInput,
		grant: ConfirmationGrant,
	) {
		return this.artifactEvaluation.save(slug, input, grant);
	}

	private recordsFromSearchJob(searchJobId: string, paperIds?: string[]): PaperRecord[] {
		const job = this.jobs.get(searchJobId);
		if (!job || job.status !== "succeeded" || !job.result || typeof job.result !== "object") {
			throw new Error("Completed literature search job was not found");
		}
		const run = (job.result as { run?: { results?: unknown } }).run;
		if (!run || !Array.isArray(run.results)) throw new Error("Search job does not contain literature results");
		const records = run.results as PaperRecord[];
		const selected = paperIds?.length ? records.filter((record) => paperIds.includes(record.id)) : records;
		if (selected.length === 0) throw new Error("No matching search results were selected");
		if (paperIds?.some((id) => !selected.some((record) => record.id === id))) {
			throw new Error("One or more selected paper ids are not present in the search result");
		}
		return selected;
	}

	private registerJobHandlers(): void {
		this.jobs.register<LiteratureSearchJobInput, unknown>("literature-search", async (input, context) => {
			const config = await loadPaperAgentConfig(this.projectRoot);
			context.report(0.05, "preparing queries");
			const queries = expandLiteratureQueries(input.query, input.queryExpansions ?? config.search.queryExpansions);
			context.report(0.1, "searching providers and existing corpus");
			const result = await collectLiterature({
				queries,
				providers: input.providers ?? (config.search.providers as LiteratureProvider[]),
				filters: input.filters ?? {},
				pagesPerProvider: input.pagesPerProvider ?? config.search.pagesPerProvider,
				maxResultsPerProvider: input.maxResultsPerProvider ?? config.search.maxResultsPerProvider,
				scope: "personal",
				mode: "once",
				namespace: input.namespace ?? this.defaultNamespace,
				cwd: this.projectRoot,
				corpusRoot: this.corpusRoot,
				reuseCorpus: input.reuseCorpus ?? config.search.reuseCorpus,
				checkpointPath: join(
					this.dataRoot,
					"runtime",
					"search-checkpoints",
					`${input.checkpointId ?? context.jobId}.json`,
				),
				signal: context.signal,
			});
			context.report(1, "search completed");
			return result;
		});
		this.jobs.register<{ pdfPath: string; refine?: boolean; ocr?: boolean }, unknown>(
			"pdf-analysis",
			async (input, context) => {
				context.report(0.05, "extracting PDF layout");
				const analyzed = await analyzePdfForLibrary(this.executor, input.pdfPath, this.projectRoot, {
					refine: input.refine,
					ocr: input.ocr,
					signal: context.signal,
				});
				const pdfSha256 = await sha256File(analyzed.pdfPath);
				const assets = await this.pdfAnnotationStore().apply(pdfSha256, analyzed.assets);
				context.report(1, "PDF analysis completed");
				return { ...analyzed, pdfSha256, assets };
			},
		);
		this.jobs.register<{ pdfPath: string }, ArtifactManifest>("artifact-discovery", async (input, context) => {
			context.report(0.1, "extracting artifact links");
			const result = await discoverArtifactsFromPdf(this.executor, input.pdfPath, context.signal);
			context.report(1, "artifact discovery completed");
			return result;
		});
		this.jobs.register<AuthorizedPdfDownloadJob, unknown>("pdf-download", async (input, context) => {
			context.report(0.05, "validating the persisted confirmation permit");
			const result = await downloadLiteraturePdfs(
				this.personalStore(input.namespace),
				{ ...input.request, signal: context.signal },
				{ manager: this.consent, permit: input.executionPermit },
			);
			context.report(1, "PDF downloads completed");
			return result;
		});
		this.jobs.register<AuthorizedArtifactJob, unknown>("artifact-acquisition", async (input, context) => {
			context.report(0.05, "checking PDF and artifact manifest");
			const manifest = await discoverArtifactsFromPdf(this.executor, input.pdfPath, context.signal);
			const result = await acquireArtifacts(this.executor, manifest, {
				candidateIds: input.candidateIds,
				maxArtifacts: input.maxArtifacts,
				maxBytesPerArtifact: input.maxBytesPerArtifact,
				signal: context.signal,
				authorization: { manager: this.consent, permit: input.executionPermit },
			});
			context.report(1, "artifact acquisition completed");
			return result;
		});
		this.jobs.register<AuthorizedCorpusImportJob, unknown>("corpus-import", async (input, context) => {
			const records = this.recordsFromSearchJob(input.searchJobId, input.paperIds);
			context.report(0.1, "validating the persisted corpus-write confirmation permit");
			const outcomes = await persistPaperRecords(this.personalStore(input.namespace), records, {
				manager: this.consent,
				permit: input.executionPermit,
			});
			context.report(1, "literature records saved");
			return {
				outcomes,
				created: outcomes.filter((outcome) => outcome.status === "created").length,
				updated: outcomes.filter((outcome) => outcome.status === "updated").length,
				unchanged: outcomes.filter((outcome) => outcome.status === "unchanged").length,
				failed: outcomes.filter((outcome) => outcome.error).length,
			};
		});
	}
}
