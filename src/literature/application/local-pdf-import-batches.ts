import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfirmationGrant, OperationPlan, PreparedOperation } from "../../shared/application/operation-consent.ts";
import type { OperationConsentManager } from "../../shared/application/operation-consent.ts";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import {
	findPossibleDuplicates,
	mergePaperRecords,
	sameLocalPdfMetadataIdentity,
	samePaperIdentity,
} from "../domain/literature-identifiers.ts";
import type { PaperCollection, PaperRecord } from "../domain/literature-types.ts";
import type { LiteratureStore } from "./literature-store.ts";
import type { PdfMetadataNeedsReview, PdfMetadataWarning } from "./literature-import-contracts.ts";
import { preparePdfImport } from "./literature-import-metadata.ts";

export const LOCAL_PDF_IMPORT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const LOCAL_PDF_IMPORT_MAX_BATCH_BYTES = 500 * 1024 * 1024;
export const LOCAL_PDF_IMPORT_MAX_FILES = 20;
const LOCAL_PDF_IMPORT_TTL_MS = 15 * 60_000;

export class LocalPdfImportError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export interface LocalPdfImportFilePreview {
	id: string;
	filename: string;
	bytes: number;
	sha256: string;
	status: "ready" | "needs_metadata";
	record?: PaperRecord;
	metadataSource?: "pdfinfo" | "text" | "ocr" | "doi";
	warnings: PdfMetadataWarning[];
	needsMetadata?: PdfMetadataNeedsReview;
	action?: "created" | "updated" | "unchanged";
}

export interface LocalPdfImportBatchView {
	id: string;
	namespace: string;
	collection?: PaperCollection;
	expiresAt: string;
	files: LocalPdfImportFilePreview[];
	acceptedCount: number;
	needsMetadataCount: number;
	providerWarnings: PdfMetadataWarning[];
	possibleDuplicates: ReturnType<typeof findPossibleDuplicates>;
	operation?: PreparedOperation;
}

interface StagedLocalPdf extends LocalPdfImportFilePreview {
	path: string;
}

interface LocalPdfImportBatch {
	id: string;
	namespace: string;
	collection?: PaperCollection;
	root: string;
	expiresAt: string;
	files: StagedLocalPdf[];
	possibleDuplicates: ReturnType<typeof findPossibleDuplicates>;
	plan?: OperationPlan;
	operation?: PreparedOperation;
}

interface LocalPdfImportBatchManagerOptions {
	root: string;
	projectRoot: string;
	executor: CommandExecutor;
	consent: OperationConsentManager;
	store: (namespace: string) => LiteratureStore;
	now?: () => Date;
}

function sanitizedUploadName(value: string): string {
	const filename = value.trim().replace(/[\u0000-\u001f]/g, "");
	if (!filename || filename.length > 500) throw new LocalPdfImportError("PDF filename must contain at most 500 characters");
	if (!filename.toLowerCase().endsWith(".pdf")) throw new LocalPdfImportError("Only PDF files can be imported");
	return filename;
}

function assertPdf(data: Uint8Array): void {
	if (data.byteLength > LOCAL_PDF_IMPORT_MAX_FILE_BYTES) {
		throw new LocalPdfImportError("PDF exceeds the 100 MB file limit", 413);
	}
	if (data.byteLength < 5 || Buffer.from(data.subarray(0, 5)).toString("latin1") !== "%PDF-") {
		throw new LocalPdfImportError("Selected file does not have a valid PDF signature");
	}
}

function sanitizePreparedRecord(record: PaperRecord, filename: string): PaperRecord {
	return {
		...record,
		links: record.links.filter((link) => {
			try {
				return new URL(link.url).protocol !== "file:";
			} catch {
				return true;
			}
		}),
		provenance: record.provenance.map((entry) => {
			if (entry.provider !== "local-pdf") return entry;
			const { rawUrl: _rawUrl, ...provenance } = entry;
			return { ...provenance, query: `web-local-pdf-import:${filename}` };
		}),
	};
}

function publicFile(file: StagedLocalPdf): LocalPdfImportFilePreview {
	const { path: _path, ...preview } = file;
	return preview;
}

export class LocalPdfImportBatchManager {
	private readonly batches = new Map<string, LocalPdfImportBatch>();
	private readonly root: string;
	private readonly projectRoot: string;
	private readonly executor: CommandExecutor;
	private readonly consent: OperationConsentManager;
	private readonly storeForNamespace: (namespace: string) => LiteratureStore;
	private readonly now: () => Date;
	private initialized = false;

	constructor(options: LocalPdfImportBatchManagerOptions) {
		this.root = options.root;
		this.projectRoot = options.projectRoot;
		this.executor = options.executor;
		this.consent = options.consent;
		this.storeForNamespace = options.store;
		this.now = options.now ?? (() => new Date());
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		await rm(this.root, { recursive: true, force: true });
		await mkdir(this.root, { recursive: true });
		this.initialized = true;
	}

	private async sweepExpired(): Promise<void> {
		await this.initialize();
		const now = this.now().getTime();
		for (const batch of this.batches.values()) {
			if (Date.parse(batch.expiresAt) <= now) await this.removeBatch(batch);
		}
	}

	private async removeBatch(batch: LocalPdfImportBatch): Promise<void> {
		this.batches.delete(batch.id);
		await rm(batch.root, { recursive: true, force: true });
	}

	private batch(id: string): LocalPdfImportBatch {
		const batch = this.batches.get(id);
		if (!batch) throw new LocalPdfImportError("Local PDF import batch was not found or has expired", 404);
		return batch;
	}

	async create(namespace: string, collectionId?: string): Promise<LocalPdfImportBatchView> {
		await this.sweepExpired();
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(namespace)) throw new LocalPdfImportError("Invalid namespace");
		const store = this.storeForNamespace(namespace);
		const collection = collectionId
			? (await store.listCollections()).find((item) => item.id === collectionId)
			: undefined;
		if (collectionId && !collection) throw new LocalPdfImportError(`Collection not found: ${collectionId}`, 404);
		const id = `local-import-${randomUUID()}`;
		const root = join(this.root, id);
		await mkdir(root, { recursive: true });
		const batch: LocalPdfImportBatch = {
			id,
			namespace,
			collection,
			root,
			expiresAt: new Date(this.now().getTime() + LOCAL_PDF_IMPORT_TTL_MS).toISOString(),
			files: [],
			possibleDuplicates: [],
		};
		this.batches.set(id, batch);
		return this.view(batch);
	}

	async addFile(id: string, requestedName: string, data: Uint8Array): Promise<LocalPdfImportFilePreview> {
		await this.sweepExpired();
		const batch = this.batch(id);
		if (batch.operation) throw new LocalPdfImportError("The import batch has already been prepared", 409);
		if (batch.files.length >= LOCAL_PDF_IMPORT_MAX_FILES) {
			throw new LocalPdfImportError("A batch can contain at most 20 PDFs", 413);
		}
		const currentBytes = batch.files.reduce((sum, file) => sum + file.bytes, 0);
		if (currentBytes + data.byteLength > LOCAL_PDF_IMPORT_MAX_BATCH_BYTES) {
			throw new LocalPdfImportError("The selected PDFs exceed the 500 MB batch limit", 413);
		}
		const filename = sanitizedUploadName(requestedName);
		assertPdf(data);
		const fileId = `file-${randomUUID()}`;
		const path = join(batch.root, `${fileId}.pdf`);
		await writeFile(path, data, { flag: "wx" });
		try {
			const prepared = await preparePdfImport(path, this.executor, this.projectRoot);
			const needsMetadata = prepared.needsMetadata
				? { ...prepared.needsMetadata, source: filename }
				: undefined;
			const file: StagedLocalPdf = {
				id: fileId,
				filename,
				bytes: data.byteLength,
				sha256: createHash("sha256").update(data).digest("hex"),
				status: prepared.record ? "ready" : "needs_metadata",
				record: prepared.record ? sanitizePreparedRecord(prepared.record, filename) : undefined,
				metadataSource: prepared.metadataSource,
				warnings: prepared.warnings,
				needsMetadata,
				path,
			};
			batch.files.push(file);
			return publicFile(file);
		} catch (error) {
			await rm(path, { force: true });
			throw error;
		}
	}

	private async prepareRecords(batch: LocalPdfImportBatch): Promise<PaperRecord[]> {
		const store = this.storeForNamespace(batch.namespace);
		const existingRecords = await store.listPapers();
		const working = [...existingRecords];
		const records: PaperRecord[] = [];
		for (const file of batch.files) {
			if (!file.record) continue;
			const candidate = batch.collection
				? { ...file.record, collectionIds: [...new Set([...(file.record.collectionIds ?? []), batch.collection.id])] }
				: file.record;
			const existing = working.find(
				(record) => samePaperIdentity(record, candidate) || sameLocalPdfMetadataIdentity(record, candidate),
			);
			const merged = existing ? mergePaperRecords(existing, candidate) : candidate;
			const existingHashes = new Set((existing?.materialHashes ?? []).map((hash) => hash.toLowerCase()));
			const sameMaterial = (candidate.materialHashes ?? []).some((hash) => existingHashes.has(hash.toLowerCase()));
			const changesCollection = Boolean(
				batch.collection && existing && !existing.collectionIds?.includes(batch.collection.id),
			);
			file.record = candidate;
			file.action = !existing
				? "created"
				: sameMaterial && !changesCollection
					? "unchanged"
					: JSON.stringify(existing) === JSON.stringify(merged)
						? "unchanged"
						: "updated";
			if (existing) working.splice(working.indexOf(existing), 1, merged);
			else working.push(merged);
			records.push(candidate);
		}
		const importedIds = new Set(records.map((record) => record.id));
		batch.possibleDuplicates = findPossibleDuplicates([...existingRecords, ...records]).filter(
			(candidate) => importedIds.has(candidate.leftId) || importedIds.has(candidate.rightId),
		);
		return records;
	}

	private plan(batch: LocalPdfImportBatch, records: PaperRecord[]): OperationPlan {
		return {
			kind: "personal-corpus-write",
			summary: `导入 ${records.length} 篇本地论文到个人库`,
			targets: records.map((record) => ({
				label: "个人库论文",
				value: record.title,
				risk: "medium" as const,
			})),
			details: {
				batchId: batch.id,
				namespace: batch.namespace,
				collectionId: batch.collection?.id,
				collectionName: batch.collection?.name,
				files: batch.files
					.filter((file) => file.record)
					.map((file) => ({ filename: file.filename, sha256: file.sha256, bytes: file.bytes })),
				recordIds: records.map((record) => record.id),
			},
		};
	}

	async prepare(id: string): Promise<LocalPdfImportBatchView> {
		await this.sweepExpired();
		const batch = this.batch(id);
		if (batch.files.length === 0) throw new LocalPdfImportError("Select at least one valid PDF");
		if (!batch.operation) {
			const records = await this.prepareRecords(batch);
			if (records.length) {
				batch.plan = this.plan(batch, records);
				batch.operation = await this.consent.prepare(batch.plan);
			}
		}
		return this.view(batch);
	}

	private view(batch: LocalPdfImportBatch): LocalPdfImportBatchView {
		const records = batch.files.flatMap((file) => (file.record ? [file.record] : []));
		return {
			id: batch.id,
			namespace: batch.namespace,
			collection: batch.collection,
			expiresAt: batch.expiresAt,
			files: batch.files.map(publicFile),
			acceptedCount: records.length,
			needsMetadataCount: batch.files.length - records.length,
			providerWarnings: batch.files.flatMap((file) => file.warnings.filter((warning) => warning.stage === "provider")),
			possibleDuplicates: batch.possibleDuplicates,
			operation: batch.operation,
		};
	}

	async execute(id: string, grant: ConfirmationGrant) {
		await this.sweepExpired();
		const batch = this.batch(id);
		if (!batch.plan || !batch.operation) {
			throw new LocalPdfImportError("Prepare the local PDF import before executing it", 409);
		}
		try {
			if (batch.collection) {
				const stillExists = (await this.storeForNamespace(batch.namespace).listCollections()).some(
					(collection) => collection.id === batch.collection?.id,
				);
				if (!stillExists) throw new LocalPdfImportError("The target collection changed; prepare the import again", 409);
			}
			await this.consent.consume(grant, batch.plan);
			const ready = batch.files.filter((file): file is StagedLocalPdf & { record: PaperRecord } => Boolean(file.record));
			const inputs = await Promise.all(
				ready.map(async (file) => {
					const body = await readFile(file.path);
					const hash = createHash("sha256").update(body).digest("hex");
					if (hash !== file.sha256) throw new Error(`PDF changed after preview: ${file.filename}`);
					return {
						record: file.record,
						sourcePath: file.path,
						sourceUrl: `file:///${encodeURIComponent(file.filename)}`,
						body: new Uint8Array(body),
					};
				}),
			);
			const reportId = `web-local-import-${randomUUID()}`;
			const result = await this.storeForNamespace(batch.namespace).importLocalPapersAtomically(inputs, {
				reportId,
				report: {
					schemaVersion: 1,
					id: reportId,
					source: "web-local-pdf-import",
					createdAt: this.now().toISOString(),
					namespace: batch.namespace,
					collectionId: batch.collection?.id,
					files: ready.map((file) => ({ filename: file.filename, sha256: file.sha256 })),
				},
			});
			await this.removeBatch(batch);
			return { ...result, namespace: batch.namespace };
		} catch (error) {
			await this.removeBatch(batch);
			throw error;
		}
	}

	async cancel(id: string): Promise<{ ok: true }> {
		await this.sweepExpired();
		const batch = this.batch(id);
		if (batch.operation) await this.consent.cancel(batch.operation.operationId, "local-user");
		await this.removeBatch(batch);
		return { ok: true };
	}

	async close(): Promise<void> {
		for (const batch of [...this.batches.values()]) await this.removeBatch(batch);
		if (this.initialized) await rm(this.root, { recursive: true, force: true });
		this.initialized = false;
	}
}
