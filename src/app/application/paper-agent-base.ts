import { join, resolve } from "node:path";
import {
	loadPaperAgentConfig,
	loadPaperAgentConfigSync,
	redactPaperAgentConfig,
	resolvePaperAgentConfigPaths,
} from "../../config/application/config-service.ts";
import { MineruService } from "../../extensions/mineru/application/mineru-service.ts";
import { PdfTranslationService } from "../../extensions/pdf-translation/application/pdf-translation-service.ts";
import { ZoteroIntegrationService } from "../../extensions/zotero/application/zotero-integration.ts";
import type { DoiProviderLookup } from "../../literature/application/literature-doi-enrichment.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../literature/application/literature-store.ts";
import { LocalPdfImportBatchManager } from "../../literature/application/local-pdf-import-batches.ts";
import type { PaperRecord, SearchRun } from "../../literature/domain/literature-types.ts";
import { literatureProviderDefinitions } from "../../literature/infrastructure/literature-providers.ts";
import { OperationConsentManager } from "../../shared/application/operation-consent.ts";
import { type CommandExecutor, NodeCommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { applyExternalToolDirectories } from "../../shared/infrastructure/external-tool-environment.ts";
import { PersistentJobQueue } from "../../shared/infrastructure/job-queue.ts";

import type { PaperAgentApplicationConfig } from "./paper-agent-contracts.ts";
export abstract class PaperAgentApplicationBase {
	readonly projectRoot: string;
	readonly dataRoot: string;
	readonly corpusRoot: string;
	readonly defaultNamespace: string;
	readonly jobs: PersistentJobQueue;
	readonly consent: OperationConsentManager;
	readonly executor: CommandExecutor;
	readonly localPdfImports: LocalPdfImportBatchManager;
	readonly zotero: ZoteroIntegrationService;
	readonly pdfTranslation: PdfTranslationService;
	readonly mineru: MineruService;
	readonly doiProviderLookup?: DoiProviderLookup;
	protected initialized = false;
	protected abstract configuredTeam(): Promise<unknown>;
	abstract listNamespaces(scope: "personal" | "team"): Promise<string[]>;
	abstract readPdfVersionBlob(paperId: string, sha256: string, namespace?: string): Promise<Buffer>;
	protected abstract recordsFromSearchJob(searchJobId: string, paperIds?: string[]): PaperRecord[];
	protected abstract recordsFromSearchRun(
		searchRunId: string,
		paperIds?: string[],
		namespace?: string,
	): Promise<PaperRecord[]>;
	protected abstract registerJobHandlers(): void;

	constructor(config: PaperAgentApplicationConfig) {
		this.projectRoot = resolve(config.projectRoot);
		this.dataRoot = resolve(config.dataRoot ?? join(this.projectRoot, ".paper-agent"));
		this.corpusRoot = resolve(config.corpusRoot ?? join(this.dataRoot, "corpus"));
		this.defaultNamespace = config.defaultNamespace ?? "default";
		applyExternalToolDirectories(loadPaperAgentConfigSync(this.projectRoot).externalTools.commandDirectories);
		this.executor = config.executor ?? new NodeCommandExecutor();
		this.doiProviderLookup = config.doiProviderLookup;
		this.consent = new OperationConsentManager({
			auditPath: join(this.dataRoot, "audit", "operations.jsonl"),
			signingKeyPath: join(this.dataRoot, "runtime", "operation-signing.key"),
		});
		this.localPdfImports = new LocalPdfImportBatchManager({
			root: join(this.dataRoot, "runtime", "local-pdf-imports"),
			projectRoot: this.projectRoot,
			executor: this.executor,
			consent: this.consent,
			store: (namespace) => this.personalStore(namespace),
		});
		this.zotero = new ZoteroIntegrationService({
			projectRoot: this.projectRoot,
			consent: this.consent,
			store: (namespace) => this.personalStore(namespace),
			defaultNamespace: this.defaultNamespace,
		});
		this.pdfTranslation = new PdfTranslationService({
			projectRoot: this.projectRoot,
			defaultNamespace: this.defaultNamespace,
			executor: this.executor,
			consent: this.consent,
			store: (namespace) => this.personalStore(namespace),
		});
		this.mineru = new MineruService({
			projectRoot: this.projectRoot,
			defaultNamespace: this.defaultNamespace,
			executor: this.executor,
			consent: this.consent,
			store: (namespace) => this.personalStore(namespace),
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
		await this.localPdfImports.close();
		this.initialized = false;
	}

	personalStore(namespace = this.defaultNamespace): LiteratureStore {
		return new LiteratureStore(
			resolveCorpusRoot(this.projectRoot, "personal", namespace, this.corpusRoot),
			"personal",
			namespace,
		);
	}

	async listSearchRuns(namespace = this.defaultNamespace): Promise<SearchRun[]> {
		return this.personalStore(namespace).listSearchRuns();
	}

	async getSearchRun(id: string, namespace = this.defaultNamespace): Promise<SearchRun | undefined> {
		return this.personalStore(namespace).getSearchRun(id);
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
		const [namespaces, records, config] = await Promise.all([
			this.listNamespaces("personal"),
			this.personalStore().listPapers(),
			loadPaperAgentConfig(this.projectRoot),
		]);
		return {
			ok: true,
			projectRoot: this.projectRoot,
			dataRoot: this.dataRoot,
			corpusRoot: this.corpusRoot,
			defaultNamespace: this.defaultNamespace,
			personalNamespaces: namespaces,
			defaultRecordCount: records.length,
			confirmations: config.confirmations,
			jobs: {
				queued: this.jobs.list({ status: "queued" }).length,
				running: this.jobs.list({ status: "running" }).length,
				failed: this.jobs.list({ status: "failed" }).length,
			},
		};
	}

	async configuration() {
		const config = await loadPaperAgentConfig(this.projectRoot);
		const redacted = redactPaperAgentConfig(config);
		return {
			...redacted,
			path: resolvePaperAgentConfigPaths(this.projectRoot).directory,
			model: config.model
				? {
						providerId: config.model.providerId,
						modelId: config.model.modelId,
						api: config.model.api,
						baseUrl: config.model.baseUrl,
						apiKeyEnvironmentVariable: config.model.apiKeyEnvironmentVariable,
						headers: config.model.headers,
						toolCallingVerifiedAt: config.model.toolCallingVerifiedAt,
						toolCallingProbe: config.model.toolCallingProbe,
						credentialsAvailable: Boolean(
							config.model.apiKey ??
								(config.model.apiKeyEnvironmentVariable
									? process.env[config.model.apiKeyEnvironmentVariable]
									: undefined),
						),
					}
				: undefined,
		};
	}

	protected configCredentialsSync(): {
		coreApiKey?: string;
		semanticScholarApiKey?: string;
		exaApiKey?: string;
		unpaywallEmail?: string;
	} {
		try {
			return loadPaperAgentConfigSync(this.projectRoot).credentials ?? {};
		} catch {
			return {};
		}
	}

	protected credentialKeyFor(
		providerId: string,
	): keyof ReturnType<PaperAgentApplicationBase["configCredentialsSync"]> {
		switch (providerId) {
			case "core":
				return "coreApiKey";
			case "semanticscholar":
				return "semanticScholarApiKey";
			case "unpaywall":
				return "unpaywallEmail";
			case "exa":
				return "exaApiKey";
			default:
				return "coreApiKey";
		}
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
			capabilities: definition.capabilities,
			searchConstraints: definition.searchConstraints,
			requiresEnvironmentVariable: definition.requiresEnvironmentVariable,
			credentialsAvailable: definition.requiresEnvironmentVariable
				? Boolean(
						process.env[definition.requiresEnvironmentVariable] ||
							this.configCredentialsSync()[this.credentialKeyFor(definition.id)],
					)
				: true,
			lastHealth: latestHealth.get(definition.id),
		}));
	}
}
