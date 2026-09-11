import { createHash } from "node:crypto";
import { loadPaperAgentConfig } from "../../../config/application/config-service.ts";
import type { PaperAgentModelConfig, PdfTranslationEngine } from "../../../config/domain/config-types.ts";
import type { LiteratureStore } from "../../../literature/application/literature-store.ts";
import type { PaperVersion } from "../../../literature/domain/literature-types.ts";
import {
	authorizeOperationExecution,
	type ConfirmationGrant,
	type OperationConsentManager,
	type OperationPlan,
	type PreparedOperation,
} from "../../../shared/application/operation-consent.ts";
import type { BackgroundJobContext } from "../../../shared/domain/background-job.ts";
import type { CommandExecutor } from "../../../shared/infrastructure/command-executor.ts";
import type {
	PdfTranslationEngineStatus,
	PdfTranslationRequest,
	PdfTranslationResult,
} from "../domain/pdf-translation-types.ts";
import { Pdf2zhNextClient, resolvePdf2zhCommand } from "../infrastructure/pdf2zh-next-client.ts";
import type { AuthorizedPdfTranslationJob } from "./pdf-translation-job.ts";

interface PdfTranslationServiceOptions {
	projectRoot: string;
	defaultNamespace: string;
	executor: CommandExecutor;
	consent: OperationConsentManager;
	store: (namespace: string) => LiteratureStore;
}

interface PreparedTranslation {
	request: PdfTranslationRequest;
	plan: OperationPlan;
	engine: PdfTranslationEngine;
	modelKey: string;
	command: string;
	expiresAt: string;
}

const LANGUAGE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,8})?$/;

function modelKey(model: PaperAgentModelConfig): string {
	return `${model.providerId}/${model.modelId}`;
}

function configuredTranslationModel(
	config: Awaited<ReturnType<typeof loadPaperAgentConfig>>,
): PaperAgentModelConfig | undefined {
	if (config.pdfTranslation.engine !== "active-model") return undefined;
	const selectedKey = config.pdfTranslation.modelKey;
	if (!selectedKey) return config.model;
	return [config.model, ...(config.models ?? [])]
		.filter((model): model is PaperAgentModelConfig => Boolean(model))
		.find((model) => modelKey(model) === selectedKey);
}

function normalizedRequest(input: Partial<PdfTranslationRequest>, defaultNamespace: string): PdfTranslationRequest {
	const request: PdfTranslationRequest = {
		paperId: input.paperId?.trim() ?? "",
		namespace: input.namespace?.trim() || defaultNamespace,
		sourceSha256: input.sourceSha256?.trim().toLowerCase() ?? "",
		sourceLanguage: input.sourceLanguage?.trim() || "en",
		targetLanguage: input.targetLanguage?.trim() || "zh-CN",
		outputMode: input.outputMode === "mono" ? "mono" : "dual",
	};
	if (!request.paperId) throw new Error("paperId is required");
	if (!/^[a-f0-9]{64}$/.test(request.sourceSha256)) throw new Error("sourceSha256 is invalid");
	if (!LANGUAGE_CODE.test(request.sourceLanguage) || !LANGUAGE_CODE.test(request.targetLanguage)) {
		throw new Error("PDF translation language code is invalid");
	}
	if (request.sourceLanguage.toLowerCase() === request.targetLanguage.toLowerCase()) {
		throw new Error("Source and target languages must differ");
	}
	return request;
}

export class PdfTranslationService {
	private readonly projectRoot: string;
	private readonly defaultNamespace: string;
	private readonly consent: OperationConsentManager;
	private readonly storeForNamespace: (namespace: string) => LiteratureStore;
	private readonly client: Pdf2zhNextClient;
	private readonly prepared = new Map<string, PreparedTranslation>();

	constructor(options: PdfTranslationServiceOptions) {
		this.projectRoot = options.projectRoot;
		this.defaultNamespace = options.defaultNamespace;
		this.consent = options.consent;
		this.storeForNamespace = options.store;
		this.client = new Pdf2zhNextClient({ executor: options.executor });
	}

	private async translationConfiguration(): Promise<{
		engine: PdfTranslationEngine;
		model?: PaperAgentModelConfig;
		modelKey: string;
		command: string;
	}> {
		const config = await loadPaperAgentConfig(this.projectRoot);
		const engine = config.pdfTranslation.engine;
		const model = configuredTranslationModel(config);
		return {
			engine,
			model,
			modelKey: engine === "siliconflowfree" ? "SiliconFlowFree" : model ? modelKey(model) : "active-model",
			command: resolvePdf2zhCommand(config.pdfTranslation.command),
		};
	}

	async status(): Promise<PdfTranslationEngineStatus> {
		const configuration = await this.translationConfiguration();
		return this.client.status(configuration.command, configuration.engine, configuration.model);
	}

	private async plan(
		request: PdfTranslationRequest,
		engine: PdfTranslationEngine,
		translationModelKey: string,
		command: string,
	): Promise<OperationPlan> {
		const store = this.storeForNamespace(request.namespace);
		const paper = await store.getPaper(request.paperId);
		if (!paper) throw new Error(`个人库中不存在论文：${request.paperId}`);
		const source = (await store.listPaperVersions(request.paperId)).find(
			(version) => version.sha256.toLowerCase() === request.sourceSha256,
		);
		if (!source) throw new Error("所选 PDF 版本不存在或已被删除");
		if (source.versionKind === "translation") throw new Error("不能再次翻译已经生成的译文版本");
		return {
			kind: "pdf-translation",
			summary: `将《${paper.title}》翻译为 ${request.targetLanguage}`,
			actor: "local-user",
			targets: [
				{ label: "论文", value: paper.title, risk: "medium" },
				{ label: "源 PDF", value: request.sourceSha256, risk: "low" },
				{ label: "译文", value: `${request.targetLanguage} / ${request.outputMode}`, risk: "medium" },
			],
			details: {
				namespace: request.namespace,
				paperId: request.paperId,
				sourceSha256: request.sourceSha256,
				sourceLanguage: request.sourceLanguage,
				targetLanguage: request.targetLanguage,
				outputMode: request.outputMode,
				engine: "pdf2zh-next",
				translationEngine: engine,
				model: translationModelKey,
				command,
			},
		};
	}

	private prunePrepared(): void {
		const now = Date.now();
		for (const [id, item] of this.prepared) {
			if (Date.parse(item.expiresAt) <= now) this.prepared.delete(id);
		}
	}

	async prepare(input: Partial<PdfTranslationRequest>): Promise<PreparedOperation> {
		const request = normalizedRequest(input, this.defaultNamespace);
		const configuration = await this.translationConfiguration();
		const status = await this.client.status(configuration.command, configuration.engine, configuration.model);
		if (!status.available) throw new Error(status.reason ?? "PDF2zh Next 不可用");
		const plan = await this.plan(request, configuration.engine, configuration.modelKey, configuration.command);
		const prepared = await this.consent.prepare(plan);
		this.prunePrepared();
		this.prepared.set(prepared.operationId, {
			request,
			plan,
			engine: configuration.engine,
			modelKey: configuration.modelKey,
			command: configuration.command,
			expiresAt: prepared.expiresAt,
		});
		return prepared;
	}

	async authorize(operationId: string, grant: ConfirmationGrant): Promise<AuthorizedPdfTranslationJob> {
		this.prunePrepared();
		const prepared = this.prepared.get(operationId);
		if (!prepared) throw new Error("PDF 翻译准备已过期，请重新操作");
		const executionPermit = await authorizeOperationExecution({ manager: this.consent, grant }, prepared.plan);
		this.prepared.delete(operationId);
		return {
			request: prepared.request,
			plan: prepared.plan,
			executionPermit,
			engine: prepared.engine,
			modelKey: prepared.modelKey,
			command: prepared.command,
		};
	}

	async cancel(operationId: string): Promise<{ cancelled: true }> {
		this.prepared.delete(operationId);
		await this.consent.cancel(operationId, "local-user");
		return { cancelled: true };
	}

	async execute(input: AuthorizedPdfTranslationJob, context: BackgroundJobContext): Promise<PdfTranslationResult> {
		await authorizeOperationExecution({ manager: this.consent, permit: input.executionPermit }, input.plan);
		const configuration = await this.translationConfiguration();
		if (
			configuration.engine !== input.engine ||
			configuration.modelKey !== input.modelKey ||
			configuration.command !== input.command
		) {
			throw new Error("翻译引擎或激活模型在确认后发生变化，请重新发起 PDF 翻译");
		}
		const store = this.storeForNamespace(input.request.namespace);
		const source = (await store.listPaperVersions(input.request.paperId)).find(
			(version) => version.sha256.toLowerCase() === input.request.sourceSha256,
		);
		if (!source) throw new Error("源 PDF 版本在任务执行前已被删除");
		if (source.versionKind === "translation") throw new Error("不能再次翻译已经生成的译文版本");
		context.report(0.08, "正在启动 PDF2zh Next");
		const translated = await this.client.translate({
			sourcePath: source.blobPath,
			sourceLanguage: input.request.sourceLanguage,
			targetLanguage: input.request.targetLanguage,
			outputMode: input.request.outputMode,
			engine: configuration.engine,
			command: configuration.command,
			model: configuration.model,
			signal: context.signal,
		});
		context.report(0.9, "正在保存翻译后的 PDF");
		const sha256 = createHash("sha256").update(translated.body).digest("hex");
		const existing = (await store.listPaperVersions(input.request.paperId)).find(
			(version) => version.sha256.toLowerCase() === sha256,
		);
		let stored = existing;
		if (!stored) {
			const blob = await store.putBlob(translated.body);
			const retrievedAt = new Date().toISOString();
			const version: PaperVersion = {
				paperId: input.request.paperId,
				sourceUrl: `paper-agent://pdf-translation/${input.request.sourceSha256}`,
				finalUrl: `paper-agent://pdf-translation/${sha256}`,
				retrievedAt,
				sha256,
				bytes: translated.body.length,
				blobPath: blob.path,
				contentType: "application/pdf",
				versionKind: "translation",
				versionLabel: `${input.request.targetLanguage}-${input.request.outputMode}`,
				relatedVersionSha256: input.request.sourceSha256,
				isPreferred: false,
				translation: {
					engine: "pdf2zh-next",
					engineVersion: translated.engineVersion,
					model: input.modelKey,
					sourceLanguage: input.request.sourceLanguage,
					targetLanguage: input.request.targetLanguage,
					outputMode: input.request.outputMode,
				},
			};
			await store.savePaperVersion(version);
			stored = (await store.listPaperVersions(input.request.paperId)).find(
				(candidate) => candidate.sha256.toLowerCase() === sha256,
			);
		}
		if (!stored) throw new Error("翻译 PDF 已生成，但未能登记到个人库");
		context.report(1, "PDF 翻译完成");
		return {
			paperId: input.request.paperId,
			namespace: input.request.namespace,
			sourceSha256: input.request.sourceSha256,
			version: {
				sha256: stored.sha256,
				bytes: stored.bytes,
				blobPath: stored.blobPath,
				versionKind: "translation",
				versionLabel: stored.versionLabel ?? `${input.request.targetLanguage}-${input.request.outputMode}`,
				retrievedAt: stored.retrievedAt,
			},
			engine: "pdf2zh-next",
			engineVersion: translated.engineVersion,
			model: input.modelKey,
			outputMode: input.request.outputMode,
		};
	}
}
