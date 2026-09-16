import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactAcquisitionPlan, assertArtifactSelection } from "../../artifacts/application/artifact-acquisition.ts";
import { artifactByteLimit } from "../../artifacts/application/artifact-limits.ts";
import { discoverPaperArtifacts } from "../../artifacts/application/paper-artifact-discovery.ts";
import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import type { MineruGenerationRequest } from "../../extensions/mineru/domain/mineru-types.ts";
import type { PdfTranslationRequest } from "../../extensions/pdf-translation/domain/pdf-translation-types.ts";
import {
	type DoiEnrichmentResult,
	enrichRecordsByDoi,
} from "../../literature/application/literature-doi-enrichment.ts";
import {
	type LiteraturePdfDownloadRequest,
	type PreparedLiteraturePdfDownload,
	prepareLiteraturePdfDownload,
} from "../../literature/application/literature-download.ts";
import { assignCollection, prepareSidebarSelection } from "../../literature/application/literature-sidebar-save.ts";
import { corpusUpsertPlan } from "../../literature/application/literature-write.ts";
import type { ArtifactManifest, PaperRecord, PaperVersion } from "../../literature/domain/literature-types.ts";
import { assertKeywordSearchProviders } from "../../literature/infrastructure/literature-providers.ts";
import { validatePdfPath } from "../../pdf/application/pdf-document.ts";
import {
	authorizeOperationExecution,
	type ConfirmationGrant,
	type PreparedOperation,
} from "../../shared/application/operation-consent.ts";
import type { BackgroundJob } from "../../shared/domain/background-job.ts";
import { requiresOperationConfirmation } from "../../shared/domain/operation-confirmation.ts";
import { PaperAgentConnector } from "./paper-agent-connector.ts";
import type {
	ArtifactAcquisitionPreparationInput,
	ArtifactDiscoveryInput,
	AuthorizedArtifactJob,
	AuthorizedCorpusImportJob,
	AuthorizedPdfDownloadJob,
	CorpusImportInput,
	LiteratureSearchJobInput,
	PdfDownloadPreparationInput,
} from "./paper-agent-contracts.ts";

export abstract class PaperAgentJobs extends PaperAgentConnector {
	private readonly preparedArtifactManifests = new Map<string, { manifest: ArtifactManifest; expiresAt: string }>();
	private readonly preparedPdfDownloads = new Map<
		string,
		{ download: PreparedLiteraturePdfDownload; expiresAt: string }
	>();
	private readonly preparedCorpusImports = new Map<
		string,
		{ records: PaperRecord[]; enrichment: Omit<DoiEnrichmentResult, "records">; expiresAt: string }
	>();

	async enqueueLiteratureSearch(input: LiteratureSearchJobInput): Promise<BackgroundJob> {
		await this.initialize();
		const config = await loadPaperAgentConfig(this.projectRoot);
		const providers = assertKeywordSearchProviders(input.providers ?? config.search.providers);
		return this.jobs.enqueue(
			"literature-search",
			{
				...input,
				query: input.query.trim(),
				queryExpansions: input.queryExpansions ?? config.search.queryExpansions,
				providers,
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

	async pdfTranslationStatus() {
		return this.pdfTranslation.status();
	}

	async preparePdfTranslation(input: Partial<PdfTranslationRequest>): Promise<PreparedOperation> {
		await this.initialize();
		return this.pdfTranslation.prepare(input);
	}

	async enqueueAuthorizedPdfTranslation(
		input: Partial<PdfTranslationRequest>,
		grant: ConfirmationGrant,
	): Promise<BackgroundJob> {
		await this.initialize();
		const authorized = await this.pdfTranslation.authorize(grant.operationId, grant);
		if (
			input.paperId !== authorized.request.paperId ||
			input.sourceSha256?.toLowerCase() !== authorized.request.sourceSha256 ||
			(input.namespace ?? this.defaultNamespace) !== authorized.request.namespace
		) {
			throw new Error("PDF translation request differs from the confirmed operation");
		}
		return this.jobs.enqueue("pdf-translation", authorized);
	}

	async cancelPdfTranslation(operationId: string) {
		return this.pdfTranslation.cancel(operationId);
	}

	async mineruStatus() {
		return this.mineru.status();
	}

	async mineruMaterial(paperId: string, namespace?: string) {
		return this.mineru.material(paperId, namespace ?? this.defaultNamespace);
	}

	async prepareMineru(input: Partial<MineruGenerationRequest>) {
		await this.initialize();
		return this.mineru.prepare(input);
	}

	async enqueueAuthorizedMineru(grant: ConfirmationGrant): Promise<BackgroundJob> {
		await this.initialize();
		const authorized = await this.mineru.authorize(grant.operationId, grant);
		return this.jobs.enqueue("mineru-extraction", authorized, { maxAttempts: 1 });
	}

	async cancelMineru(operationId: string) {
		return this.mineru.cancel(operationId);
	}

	async enqueueArtifactDiscovery(input: ArtifactDiscoveryInput): Promise<BackgroundJob> {
		await this.initialize();
		return this.jobs.enqueue("artifact-discovery", input);
	}

	async deleteJob(id: string): Promise<{ ok: true }> {
		await this.initialize();
		const job = this.jobs.get(id);
		if (!job) throw new Error("Job not found");
		if (["queued", "running", "paused"].includes(job.status)) {
			throw new Error(`Cannot delete a ${job.status} job; cancel it first`);
		}
		this.jobs.delete(id);
		return { ok: true };
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
			publicationVersionId: input.publicationVersionId,
			maxFiles: input.maxFiles ?? 20,
			maxBytesPerFile: (input.maxMegabytesPerFile ?? 50) * 1024 * 1024,
			concurrency: input.concurrency ?? 3,
			projectRoot: this.projectRoot,
		};
		const download = await prepareLiteraturePdfDownload(store, request);
		const prepared = await this.consent.prepare(download.plan);
		this.preparedPdfDownloads.set(prepared.operationId, { download, expiresAt: prepared.expiresAt });
		return prepared;
	}

	async prepareArtifactAcquisition(
		input: ArtifactAcquisitionPreparationInput,
	): Promise<{ prepared: PreparedOperation; manifest: ArtifactManifest }> {
		await this.initialize();
		const manifest = await this.discoverArtifactManifest(input);
		const unknownIds = (input.candidateIds ?? []).filter(
			(id) => !manifest.candidates.some((candidate) => candidate.id === id),
		);
		if (unknownIds.length) throw new Error(`Unknown artifact candidate ids: ${unknownIds.join(", ")}`);
		assertArtifactSelection(manifest, input.candidateIds);
		const plan = artifactAcquisitionPlan(manifest, {
			candidateIds: input.candidateIds,
			maxArtifacts: input.maxArtifacts ?? 10,
			maxBytesPerArtifact: artifactByteLimit(input.maxMegabytesPerArtifact),
		});
		const prepared = await this.consent.prepare(plan);
		this.preparedArtifactManifests.set(prepared.operationId, { manifest, expiresAt: prepared.expiresAt });
		return { prepared, manifest };
	}

	protected async discoverArtifactManifest(
		input: ArtifactDiscoveryInput,
		signal?: AbortSignal,
	): Promise<ArtifactManifest> {
		const config = await loadPaperAgentConfig(this.projectRoot);
		const namespace = input.namespace ?? config.storage.defaultNamespace ?? this.defaultNamespace;
		const paper = input.paperId ? await this.personalStore(namespace).getPaper(input.paperId) : undefined;
		if (input.paperId && !paper) throw new Error(`Paper not found in personal corpus: ${input.paperId}`);
		return discoverPaperArtifacts(this.executor, input.pdfPath, {
			signal,
			sourceDirectory: input.sourceDirectory ? resolve(this.projectRoot, input.sourceDirectory) : undefined,
			paper,
			additionalCandidateUrls: input.additionalCandidateUrls,
			githubToken: config.credentials?.githubToken,
		});
	}

	private preparedArtifactManifest(operationId: string): ArtifactManifest {
		const now = Date.now();
		for (const [id, item] of this.preparedArtifactManifests) {
			if (Date.parse(item.expiresAt) <= now) this.preparedArtifactManifests.delete(id);
		}
		const prepared = this.preparedArtifactManifests.get(operationId);
		if (!prepared) throw new Error("Prepared artifact manifest was not found or has expired; prepare again");
		return prepared.manifest;
	}

	private preparedPdfDownload(operationId: string): PreparedLiteraturePdfDownload {
		const now = Date.now();
		for (const [id, item] of this.preparedPdfDownloads) {
			if (Date.parse(item.expiresAt) <= now) this.preparedPdfDownloads.delete(id);
		}
		const prepared = this.preparedPdfDownloads.get(operationId);
		if (!prepared) throw new Error("Prepared PDF candidates were not found or have expired; prepare again");
		return prepared.download;
	}

	/** 读取待导入记录, 若指定分类则统一应用 collectionId, 保证 prepare/permit/写入三处 fingerprint 一致。 */
	protected async readImportRecords(input: CorpusImportInput): Promise<PaperRecord[]> {
		let records: PaperRecord[];
		if (input.searchRunId) {
			records = await this.recordsFromSearchRun(
				input.searchRunId,
				input.paperIds,
				input.namespace ?? this.defaultNamespace,
			);
		} else {
			records = this.recordsFromSearchJob(input.searchJobId ?? "", input.paperIds);
		}
		return records;
	}

	async prepareCorpusImport(input: CorpusImportInput): Promise<PreparedOperation> {
		await this.initialize();
		const sidebar = input.sidebarResultUrl
			? await prepareSidebarSelection(
					this.personalStore(input.namespace),
					this.projectRoot,
					input.sidebarResultUrl,
					input.paperIds,
					{ lookup: this.doiProviderLookup },
				)
			: undefined;
		if (sidebar?.resolution.missingPaperIds.length) {
			throw new Error(
				`One or more selected papers are not backed by a persisted search result: ${sidebar.resolution.missingPaperIds.join(", ")}`,
			);
		}
		const enrichment = sidebar
			? { records: sidebar.records, ...sidebar.enrichment }
			: await enrichRecordsByDoi(await this.readImportRecords(input), this.projectRoot, {
					lookup: this.doiProviderLookup,
				});
		const records = assignCollection(enrichment.records, input.collectionId);
		const prepared = await this.consent.prepare(corpusUpsertPlan(this.personalStore(input.namespace), records));
		this.preparedCorpusImports.set(prepared.operationId, {
			records,
			enrichment: {
				attempts: enrichment.attempts,
				warnings: enrichment.warnings,
				skippedWithoutDoi: enrichment.skippedWithoutDoi,
				skippedComplete: enrichment.skippedComplete,
			},
			expiresAt: prepared.expiresAt,
		});
		return prepared;
	}

	async confirmOperation(operationId: string, manifestFingerprint: string): Promise<ConfirmationGrant> {
		const prepared = this.consent.preparedOperation(operationId);
		const config = await loadPaperAgentConfig(this.projectRoot);
		const confirmedBy =
			prepared && !requiresOperationConfirmation(prepared.kind, "web", config.confirmations)
				? "local-confirmation-policy"
				: "local-user";
		return this.consent.confirm(operationId, manifestFingerprint, confirmedBy);
	}

	async enqueueAuthorizedPdfDownload(
		input: PdfDownloadPreparationInput,
		grant: ConfirmationGrant,
	): Promise<BackgroundJob> {
		await this.initialize();
		const namespace = input.namespace ?? this.defaultNamespace;
		const request: LiteraturePdfDownloadRequest = {
			paperIds: input.paperIds,
			publicationVersionId: input.publicationVersionId,
			maxFiles: input.maxFiles ?? 20,
			maxBytesPerFile: (input.maxMegabytesPerFile ?? 50) * 1024 * 1024,
			concurrency: input.concurrency ?? 3,
			projectRoot: this.projectRoot,
		};
		const prepared = this.preparedPdfDownload(grant.operationId);
		const executionPermit = await authorizeOperationExecution({ manager: this.consent, grant }, prepared.plan);
		this.preparedPdfDownloads.delete(grant.operationId);
		const jobInput: AuthorizedPdfDownloadJob = {
			executionPermit,
			namespace,
			request,
			prepared,
		};
		return this.jobs.enqueue("pdf-download", jobInput);
	}

	async enqueueAuthorizedArtifactAcquisition(
		input: ArtifactAcquisitionPreparationInput,
		grant: ConfirmationGrant,
	): Promise<BackgroundJob> {
		await this.initialize();
		const manifest = this.preparedArtifactManifest(grant.operationId);
		const unknownIds = (input.candidateIds ?? []).filter(
			(id) => !manifest.candidates.some((candidate) => candidate.id === id),
		);
		if (unknownIds.length) throw new Error(`Unknown artifact candidate ids: ${unknownIds.join(", ")}`);
		assertArtifactSelection(manifest, input.candidateIds);
		const maxArtifacts = input.maxArtifacts ?? 10;
		const maxBytesPerArtifact = artifactByteLimit(input.maxMegabytesPerArtifact);
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
			manifest,
			paperId: input.paperId,
			namespace: input.namespace ?? this.defaultNamespace,
			candidateIds: input.candidateIds,
			maxArtifacts,
			maxBytesPerArtifact,
		};
		this.preparedArtifactManifests.delete(grant.operationId);
		return this.jobs.enqueue("artifact-acquisition", jobInput);
	}

	/** 免确认保存(UI 用户主动保存): 内部以 local-user 确认后直接入队, 前端无需弹确认卡片。 */
	async saveCorpusImport(input: CorpusImportInput): Promise<BackgroundJob> {
		await this.initialize();
		const prepared = await this.prepareCorpusImport(input);
		const grant = await this.consent.confirm(prepared.operationId, prepared.manifestFingerprint, "local-user");
		return this.enqueueAuthorizedCorpusImport(input, grant);
	}

	async enqueueAuthorizedCorpusImport(input: CorpusImportInput, grant: ConfirmationGrant): Promise<BackgroundJob> {
		await this.initialize();
		const now = Date.now();
		for (const [id, item] of this.preparedCorpusImports) {
			if (Date.parse(item.expiresAt) <= now) this.preparedCorpusImports.delete(id);
		}
		const prepared = this.preparedCorpusImports.get(grant.operationId);
		if (!prepared) throw new Error("Prepared corpus records were not found or have expired; prepare again");
		const executionPermit = await authorizeOperationExecution(
			{ manager: this.consent, grant },
			corpusUpsertPlan(this.personalStore(input.namespace), prepared.records),
		);
		this.preparedCorpusImports.delete(grant.operationId);
		return this.jobs.enqueue("corpus-import", {
			...input,
			executionPermit,
			records: prepared.records,
			doiEnrichment: prepared.enrichment,
		} satisfies AuthorizedCorpusImportJob);
	}

	async readPdfVersionBlob(paperId: string, sha256: string, namespace = this.defaultNamespace): Promise<Buffer> {
		return this.personalStore(namespace).readPaperVersionBlob(paperId, sha256);
	}

	/**
	 * 把用户本地手动下载的 PDF 关联到个人库已有的论文(存 blob + 版本, 更新 materialHashes)。
	 * 用于"从本地加载"——用户网页手动下载 PDF 后上传关联到论文。
	 */
	async addLocalPdfToPaper(paperId: string, data: Buffer, namespace = this.defaultNamespace): Promise<PaperVersion> {
		const store = this.personalStore(namespace);
		const paper = await store.getPaper(paperId);
		if (!paper) throw new Error(`Paper not found in corpus: ${paperId}`);
		if (data.length === 0) throw new Error("PDF 内容为空");
		if (data.length > 100 * 1024 * 1024) throw new Error("PDF 超过 100MB 限制");
		const blob = await store.putBlob(new Uint8Array(data));
		const localUrl = `file:///${paperId}.pdf`;
		// 若已存在相同 sha256 的版本则不重复保存(避免版本列表累积重复)。
		const existingVersions = await store.listPaperVersions(paperId);
		const alreadySaved = existingVersions.some((item) => item.sha256 === blob.sha256);
		let storedVersion = existingVersions.find((item) => item.sha256 === blob.sha256);
		if (!alreadySaved) {
			const publicationVersion = (await store.ensurePublicationVersions(paperId, true)).find(
				(item) => item.kind === "published",
			);
			const version: PaperVersion = {
				paperId,
				publicationVersionId: publicationVersion?.id,
				sourceUrl: localUrl,
				finalUrl: localUrl,
				retrievedAt: new Date().toISOString(),
				sha256: blob.sha256,
				bytes: data.length,
				blobPath: blob.path,
				contentType: "application/pdf",
				versionKind: "published",
				isPreferred: true,
			};
			await store.savePaperVersion(version);
			storedVersion = version;
		}
		// 精确更新当前论文的材料指纹，避免触发跨论文身份合并。
		await store.attachMaterialHash(paperId, blob.sha256);
		return (
			storedVersion ?? {
				paperId,
				sourceUrl: localUrl,
				finalUrl: localUrl,
				retrievedAt: new Date().toISOString(),
				sha256: blob.sha256,
				bytes: data.length,
				blobPath: blob.path,
				contentType: "application/pdf",
				versionKind: "published",
				isPreferred: true,
			}
		);
	}

	async readLocalPdf(inputPath: string): Promise<{ path: string; body: Buffer }> {
		const path = await validatePdfPath(inputPath, this.projectRoot);
		return { path, body: await readFile(path) };
	}

	protected recordsFromSearchJob(searchJobId: string, paperIds?: string[]): PaperRecord[] {
		const job = this.jobs.get(searchJobId);
		if (!job || job.status !== "succeeded" || !job.result || typeof job.result !== "object") {
			throw new Error("Completed literature search job was not found");
		}
		const run = (job.result as { run?: { results?: unknown } }).run;
		if (!run || !Array.isArray(run.results)) throw new Error("Search job does not contain literature results");
		return this.filterRecords(run.results as PaperRecord[], paperIds);
	}

	protected async recordsFromSearchRun(
		searchRunId: string,
		paperIds: string[] | undefined,
		namespace: string,
	): Promise<PaperRecord[]> {
		const run = await this.getSearchRun(searchRunId, namespace);
		if (!run) throw new Error(`Search run was not found in namespace ${namespace}: ${searchRunId}`);
		return this.filterRecords(run.results, paperIds);
	}

	protected filterRecords(records: PaperRecord[], paperIds?: string[]): PaperRecord[] {
		const selected = paperIds?.length ? records.filter((record) => paperIds.includes(record.id)) : records;
		if (selected.length === 0) throw new Error("No matching search results were selected");
		if (paperIds?.some((id) => !selected.some((record) => record.id === id))) {
			throw new Error("One or more selected paper ids are not present in the search result");
		}
		return selected;
	}
}
