import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { loadPaperAgentConfig } from "../../../config/application/config-service.ts";
import type { LiteratureStore } from "../../../literature/application/literature-store.ts";
import type { PaperVersion } from "../../../literature/domain/literature-types.ts";
import { getPdfPageCount } from "../../../pdf/application/pdf-document.ts";
import type { PdfMaterialRecord } from "../../../pdf/domain/pdf-material-types.ts";
import {
	authorizeOperationExecution,
	type ConfirmationGrant,
	type OperationConsentManager,
	type OperationPlan,
	type PreparedOperation,
} from "../../../shared/application/operation-consent.ts";
import type { BackgroundJobContext } from "../../../shared/domain/background-job.ts";
import type { CommandExecutor } from "../../../shared/infrastructure/command-executor.ts";
import type { MineruConfiguration, MineruGenerationRequest, MineruJobCheckpoint } from "../domain/mineru-types.ts";
import { extractMineruArchive, findArchiveExtractor } from "../infrastructure/mineru-archive.ts";
import { downloadMineruZip, submitMineruFile, waitForMineruResult } from "../infrastructure/mineru-client.ts";
import type { AuthorizedMineruJob } from "./mineru-job.ts";
import { normalizeMineruPackage, replaceDirectory } from "./mineru-package.ts";
import { type MineruReadRequest, readMineruMaterial, resolveMineruAsset } from "./mineru-reader.ts";

interface MineruServiceOptions {
	projectRoot: string;
	defaultNamespace: string;
	executor: CommandExecutor;
	consent: OperationConsentManager;
	store: (namespace: string) => LiteratureStore;
}

interface PreparedGeneration {
	request: MineruGenerationRequest;
	source: PaperVersion;
	configuration: Omit<MineruConfiguration, "apiKey">;
	plan: OperationPlan;
	expiresAt: string;
}

interface PreparedDeletion {
	paperId: string;
	namespace: string;
	plan: OperationPlan;
	expiresAt: string;
}

const preferredVersion = (versions: PaperVersion[]): PaperVersion | undefined => {
	const rank = (version: PaperVersion) =>
		version.isPreferred
			? -1
			: ({ published: 0, preprint: 1, unknown: 2, translation: 3, supplement: 4 }[
					version.versionKind ?? "unknown"
				] ?? 5);
	return [...versions].sort(
		(left, right) => rank(left) - rank(right) || right.retrievedAt.localeCompare(left.retrievedAt),
	)[0];
};

function safePaperId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,499}$/.test(value)) throw new Error("paperId is invalid");
	return value;
}

export class MineruService {
	private readonly options: MineruServiceOptions;
	private readonly prepared = new Map<string, PreparedGeneration>();
	private readonly preparedDeletions = new Map<string, PreparedDeletion>();

	constructor(options: MineruServiceOptions) {
		this.options = options;
	}

	private async configuration(): Promise<MineruConfiguration> {
		const config = await loadPaperAgentConfig(this.options.projectRoot);
		const apiKey = config.credentials?.mineruApiKey;
		if (!apiKey) throw new Error("MinerU API key is not configured");
		return { ...config.mineru, apiKey };
	}

	async status() {
		const config = await loadPaperAgentConfig(this.options.projectRoot);
		const archiveExtractor = await findArchiveExtractor(this.options.executor);
		const configured = Boolean(config.credentials?.mineruApiKey);
		return {
			configured,
			baseUrl: config.mineru.baseUrl,
			modelVersion: config.mineru.modelVersion,
			language: config.mineru.language,
			archiveExtractor,
			available: configured && Boolean(archiveExtractor),
			reason: !configured
				? "MinerU API key is not configured"
				: !archiveExtractor
					? "unzip or tar is required"
					: undefined,
		};
	}

	private prune(): void {
		const now = Date.now();
		for (const [id, item] of this.prepared) if (Date.parse(item.expiresAt) <= now) this.prepared.delete(id);
		for (const [id, item] of this.preparedDeletions)
			if (Date.parse(item.expiresAt) <= now) this.preparedDeletions.delete(id);
	}

	async material(paperId: string, namespace = this.options.defaultNamespace) {
		const store = this.options.store(namespace);
		const [record, versions, material] = await Promise.all([
			store.getPaper(paperId),
			store.listPaperVersions(paperId),
			store.getPdfMaterial(paperId),
		]);
		if (!record) throw new Error(`Paper not found in personal corpus: ${paperId}`);
		const preferred = preferredVersion(versions);
		const present = material
			? await access(material.path)
					.then(() => true)
					.catch(() => false)
			: false;
		return {
			paperId,
			namespace,
			material: present ? material : undefined,
			missing: Boolean(material && !present),
			preferredSha256: preferred?.sha256,
			stale: Boolean(material && preferred && material.sourceSha256 !== preferred.sha256),
		};
	}

	async prepare(
		input: Partial<MineruGenerationRequest>,
	): Promise<{ operation?: PreparedOperation; reused?: boolean; material?: unknown }> {
		const request: MineruGenerationRequest = {
			paperId: safePaperId(input.paperId?.trim() ?? ""),
			namespace: input.namespace?.trim() || this.options.defaultNamespace,
			force: input.force === true,
		};
		const configuration = await this.configuration();
		const extractor = await findArchiveExtractor(this.options.executor);
		if (!extractor) throw new Error("MinerU requires the system unzip or tar command");
		const store = this.options.store(request.namespace);
		const [paper, versions, existing] = await Promise.all([
			store.getPaper(request.paperId),
			store.listPaperVersions(request.paperId),
			store.getPdfMaterial(request.paperId),
		]);
		if (!paper) throw new Error(`Paper not found in personal corpus: ${request.paperId}`);
		const source = preferredVersion(versions);
		if (!source) throw new Error("This paper has no local PDF version");
		if (source.bytes > 200 * 1024 * 1024) throw new Error("MinerU source PDF exceeds 200 MB");
		const pageCount = await getPdfPageCount(this.options.executor, source.blobPath);
		if (pageCount > 600) throw new Error("MinerU source PDF exceeds 600 pages");
		const existingPresent = existing
			? await access(existing.path)
					.then(() => true)
					.catch(() => false)
			: false;
		if (
			!request.force &&
			existingPresent &&
			existing?.sourceSha256 === source.sha256 &&
			existing.modelVersion === configuration.modelVersion
		) {
			return { reused: true, material: existing };
		}
		const plan: OperationPlan = {
			kind: "pdf-material-generation",
			summary: `Generate MinerU reading material for ${paper.title}`,
			actor: "local-user",
			targets: [{ label: "PDF", value: `${request.paperId}/${source.sha256}`, risk: "medium" }],
			details: {
				namespace: request.namespace,
				paperId: request.paperId,
				sourceSha256: source.sha256,
				bytes: source.bytes,
				pageCount,
				baseUrl: configuration.baseUrl,
				modelVersion: configuration.modelVersion,
				language: configuration.language,
			},
		};
		const operation = await this.options.consent.prepare(plan);
		this.prune();
		this.prepared.set(operation.operationId, {
			request,
			source,
			configuration: {
				baseUrl: configuration.baseUrl,
				modelVersion: configuration.modelVersion,
				language: configuration.language,
			},
			plan,
			expiresAt: operation.expiresAt,
		});
		return { operation };
	}

	async authorize(operationId: string, grant: ConfirmationGrant): Promise<AuthorizedMineruJob> {
		this.prune();
		const prepared = this.prepared.get(operationId);
		if (!prepared) throw new Error("Prepared MinerU operation was not found or expired");
		const executionPermit = await authorizeOperationExecution(
			{ manager: this.options.consent, grant },
			prepared.plan,
		);
		this.prepared.delete(operationId);
		return {
			request: prepared.request,
			source: {
				path: prepared.source.blobPath,
				sha256: prepared.source.sha256,
				bytes: prepared.source.bytes,
				versionKind: prepared.source.versionKind,
			},
			configuration: prepared.configuration,
			plan: prepared.plan,
			executionPermit,
		};
	}

	async cancel(operationId: string): Promise<{ cancelled: true }> {
		this.prepared.delete(operationId);
		this.preparedDeletions.delete(operationId);
		await this.options.consent.cancel(operationId, "local-user");
		return { cancelled: true };
	}

	async execute(input: AuthorizedMineruJob, context: BackgroundJobContext) {
		await authorizeOperationExecution({ manager: this.options.consent, permit: input.executionPermit }, input.plan);
		const configuration = await this.configuration();
		if (
			configuration.baseUrl !== input.configuration.baseUrl ||
			configuration.modelVersion !== input.configuration.modelVersion ||
			configuration.language !== input.configuration.language
		)
			throw new Error("MinerU configuration changed after confirmation; prepare the operation again");
		const store = this.options.store(input.request.namespace);
		const currentSource = preferredVersion(await store.listPaperVersions(input.request.paperId));
		if (!currentSource || currentSource.sha256 !== input.source.sha256) {
			throw new Error("The preferred PDF changed after MinerU generation was confirmed");
		}
		const body = await readFile(input.source.path);
		if (createHash("sha256").update(body).digest("hex") !== input.source.sha256) {
			throw new Error("The source PDF changed after confirmation");
		}
		const runtimeRoot = join(store.personalDataRoot, "runtime", "mineru", context.jobId);
		const archivePath = join(runtimeRoot, "result.zip");
		const rawRoot = join(runtimeRoot, "raw");
		const normalizedRoot = join(runtimeRoot, "normalized");
		await rm(runtimeRoot, { recursive: true, force: true });
		await mkdir(runtimeRoot, { recursive: true });
		try {
			let checkpoint = context.checkpoint?.<MineruJobCheckpoint>();
			if (!checkpoint || checkpoint.sourceSha256 !== input.source.sha256) {
				context.report(0.08, "Requesting MinerU upload URL");
				const dataId = `paper-${input.source.sha256}`;
				checkpoint = await submitMineruFile(
					configuration,
					{ filename: `${safePaperId(input.request.paperId)}.pdf`, body, dataId },
					context.signal,
				);
				checkpoint.sourceSha256 = input.source.sha256;
				context.saveCheckpoint?.(checkpoint);
			}
			context.report(0.3, "Waiting for MinerU extraction");
			const zipUrl = await waitForMineruResult(configuration, checkpoint, context.signal, context.report);
			context.report(0.78, "Downloading MinerU package");
			const downloaded = await downloadMineruZip(zipUrl, archivePath, context.signal);
			const extractor = await findArchiveExtractor(this.options.executor);
			if (!extractor) throw new Error("unzip or tar is required to extract MinerU material");
			context.report(0.86, `Extracting MinerU package with ${extractor}`);
			await extractMineruArchive(this.options.executor, extractor, archivePath, rawRoot);
			const createdAt = new Date().toISOString();
			const normalized = await normalizeMineruPackage({
				rawRoot,
				normalizedRoot,
				sourceSha256: input.source.sha256,
				modelVersion: configuration.modelVersion,
				createdAt,
			});
			const paperRoot = dirname(resolve(input.source.path));
			const targetRoot = join(paperRoot, "mineru");
			const installRoot = join(paperRoot, `.mineru-${context.jobId}.tmp`);
			const backupRoot = join(paperRoot, `.mineru-${context.jobId}.bak`);
			await mkdir(paperRoot, { recursive: true });
			await rm(installRoot, { recursive: true, force: true });
			await rename(normalizedRoot, installRoot);
			let saved: PdfMaterialRecord | undefined;
			await replaceDirectory(installRoot, targetRoot, backupRoot, async () => {
				saved = await store.savePdfMaterial({
					paperId: input.request.paperId,
					sourceSha256: input.source.sha256,
					relativePath: relative(store.personalDataRoot, targetRoot),
					engine: "mineru",
					modelVersion: configuration.modelVersion,
					packageSha256: downloaded.sha256,
					contentSha256: normalized.contentSha256,
					pageCount: normalized.manifest.pageCount,
					fileCount: normalized.fileCount,
					bytes: normalized.bytes,
				});
			});
			if (!saved) throw new Error("MinerU material was installed but not indexed");
			context.report(1, "MinerU reading material is ready");
			return saved;
		} finally {
			await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async openFolder(paperId: string, namespace = this.options.defaultNamespace) {
		const material = await this.options.store(namespace).getPdfMaterial(paperId);
		if (!material) throw new Error("This paper has no MinerU material");
		await access(material.path).catch(() => {
			throw new Error("The MinerU material directory is missing");
		});
		const command =
			process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
		const result = await this.options.executor.exec(command, [material.path], { detached: true });
		if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || "Could not open MinerU folder");
		return { opened: true, path: material.path };
	}

	async read(paperId: string, namespace: string, request?: MineruReadRequest) {
		const material = await this.options.store(namespace).getPdfMaterial(paperId);
		if (!material) throw new Error("This paper has no MinerU material");
		return readMineruMaterial(material, request);
	}

	async readAsset(paperId: string, namespace: string, assetPath: string): Promise<{ path: string; body: Buffer }> {
		const material = await this.options.store(namespace).getPdfMaterial(paperId);
		if (!material) throw new Error("This paper has no MinerU material");
		const path = resolveMineruAsset(material, assetPath);
		return { path, body: await readFile(path) };
	}

	async prepareDelete(paperId: string, namespace = this.options.defaultNamespace): Promise<PreparedOperation> {
		const material = await this.options.store(namespace).getPdfMaterial(safePaperId(paperId));
		if (!material) throw new Error("This paper has no MinerU material");
		const plan: OperationPlan = {
			kind: "pdf-material-delete",
			summary: "删除这篇论文的 MinerU 解析材料",
			actor: "local-user",
			targets: [{ label: "MinerU 材料", value: material.path, risk: "medium" }],
			details: { namespace, paperId, sourceSha256: material.sourceSha256 },
		};
		const operation = await this.options.consent.prepare(plan);
		this.preparedDeletions.set(operation.operationId, { paperId, namespace, plan, expiresAt: operation.expiresAt });
		return operation;
	}

	async executeDelete(grant: ConfirmationGrant) {
		this.prune();
		const prepared = this.preparedDeletions.get(grant.operationId);
		if (!prepared) throw new Error("Prepared MinerU deletion was not found or expired");
		await authorizeOperationExecution({ manager: this.options.consent, grant }, prepared.plan);
		this.preparedDeletions.delete(grant.operationId);
		return this.delete(prepared.paperId, prepared.namespace);
	}

	async delete(paperId: string, namespace = this.options.defaultNamespace) {
		const store = this.options.store(namespace);
		const existing = await store.getPdfMaterial(paperId);
		if (!existing) return { deleted: false };
		const source = resolve(existing.path);
		const trash = `${source}.delete-${randomUUID()}.tmp`;
		let moved = false;
		try {
			await rename(source, trash);
			moved = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await store.deletePdfMaterial(paperId);
		} catch (error) {
			if (moved) await rename(trash, source).catch(() => undefined);
			throw error;
		}
		await rm(trash, { recursive: true, force: true }).catch(() => undefined);
		return { deleted: true };
	}
}
