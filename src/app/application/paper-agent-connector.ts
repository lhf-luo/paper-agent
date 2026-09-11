import { readFile, stat } from "node:fs/promises";
import {
	type CapturedPageMetadata,
	CapturedPdfValidationError,
	CONNECTOR_MAX_PDF_BYTES,
	importCapturedPdf,
} from "../../literature/application/local-literature-import.ts";
import type { ConfirmationGrant } from "../../shared/application/operation-consent.ts";
import { PaperAgentLibraryMutations } from "./paper-agent-library-mutations.ts";

export interface ConnectorCaptureInput {
	metadata: CapturedPageMetadata;
	namespace?: string;
	collection?: string;
	signal?: AbortSignal;
}

export abstract class PaperAgentConnector extends PaperAgentLibraryMutations {
	async zoteroStatus() {
		return this.zotero.status();
	}

	async authorizeZotero() {
		return this.zotero.authorize();
	}

	async listZoteroCollections() {
		return this.zotero.collections();
	}

	async listZoteroItems(query?: string) {
		return this.zotero.items(query);
	}

	async prepareZoteroImport(input: Record<string, unknown>) {
		return this.zotero.prepareImport(input);
	}

	async executeZoteroImport(operationId: string, grant: ConfirmationGrant) {
		return this.zotero.executeImport(operationId, grant);
	}

	async executeZoteroImportItem(operationId: string, itemKey: string, grant: ConfirmationGrant) {
		return this.zotero.executeImportItem(operationId, itemKey, grant);
	}

	async cancelZoteroImport(operationId: string) {
		return this.zotero.cancelImport(operationId);
	}

	async prepareZoteroExport(input: Record<string, unknown>) {
		return this.zotero.prepareExport(input);
	}

	async executeZoteroExport(operationId: string, grant: ConfirmationGrant) {
		return this.zotero.executeExport(operationId, grant);
	}

	async cancelZoteroExport(operationId: string) {
		return this.zotero.cancelExport(operationId);
	}

	async createLocalPdfImportBatch(namespace = this.defaultNamespace, collectionId?: string) {
		await this.initialize();
		return this.localPdfImports.create(namespace, collectionId);
	}

	async addLocalPdfImportFile(batchId: string, filename: string, data: Uint8Array) {
		await this.initialize();
		return this.localPdfImports.addFile(batchId, filename, data);
	}

	async prepareLocalPdfImport(batchId: string) {
		await this.initialize();
		return this.localPdfImports.prepare(batchId);
	}

	async executeLocalPdfImport(batchId: string, grant: ConfirmationGrant) {
		await this.initialize();
		return this.localPdfImports.execute(batchId, grant);
	}

	async cancelLocalPdfImport(batchId: string) {
		await this.initialize();
		return this.localPdfImports.cancel(batchId);
	}

	async connectorStatus() {
		await this.initialize();
		const personal = await this.listNamespaces("personal");
		return {
			ok: true,
			defaultNamespace: this.defaultNamespace,
			namespaces: [...new Set([this.defaultNamespace, ...personal])],
		};
	}

	async capturePdfFromLocalPath(input: ConnectorCaptureInput, localPath: string) {
		try {
			const details = await stat(localPath);
			if (!details.isFile()) throw new Error("not a file");
			if (details.size > CONNECTOR_MAX_PDF_BYTES) {
				throw new CapturedPdfValidationError("PDF exceeds the 100 MB connector limit");
			}
			const namespace = input.namespace ?? this.defaultNamespace;
			return await importCapturedPdf(this.personalStore(namespace), this.executor, this.projectRoot, {
				metadata: input.metadata,
				collection: input.collection,
				body: await readFile(localPath),
				signal: input.signal,
			});
		} catch (error) {
			if (error instanceof CapturedPdfValidationError) throw error;
			throw new CapturedPdfValidationError(
				`Browser temporary PDF could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
