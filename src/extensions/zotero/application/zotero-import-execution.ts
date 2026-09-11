import { createHash, randomUUID } from "node:crypto";
import type { LiteratureStore } from "../../../literature/application/literature-store.ts";
import type { PaperRecord } from "../../../literature/domain/literature-types.ts";
import type {
	ConfirmationGrant,
	OperationConsentManager,
	OperationPlan,
} from "../../../shared/application/operation-consent.ts";
import type {
	ZoteroCollectionImportSpec,
	ZoteroImportPreviewItem,
	ZoteroImportPreparation,
	ZoteroImportResult,
	ZoteroPaperImportMapping,
} from "../domain/zotero-types.ts";
import type { ZoteroLocalApiClient } from "../infrastructure/zotero-local-api-client.ts";

export interface PreparedZoteroImportInput {
	record: PaperRecord;
	body?: Uint8Array;
	sourcePath?: string;
	sourceUrl?: string;
	originalFilename?: string;
	zotero: ZoteroPaperImportMapping;
}

export interface PreparedZoteroImportState {
	view: ZoteroImportPreparation;
	plan: OperationPlan;
	started: boolean;
	inputs: PreparedZoteroImportInput[];
}

export async function executePreparedZoteroImports(options: {
	inputs: PreparedZoteroImportInput[];
	collectionSpecs: ZoteroCollectionImportSpec[];
	previewItems: ZoteroImportPreviewItem[];
	serverId: string;
	store: LiteratureStore;
	validate: (input: PreparedZoteroImportInput) => Promise<void>;
}): Promise<ZoteroImportResult> {
	const result: ZoteroImportResult = { imported: 0, outcomes: [], records: [], failed: [] };
	for (const input of options.inputs) {
		try {
			await options.validate(input);
			const imported = await options.store.importLocalPapersAtomically([input], {
				collectionSpecs: options.collectionSpecs,
				reportId: `zotero-import-${randomUUID()}`,
				report: {
					source: "zotero",
					serverId: options.serverId,
					item: options.previewItems.find((item) => item.itemKey === input.zotero.itemKey),
				},
			});
			result.imported += imported.outcomes.filter((outcome) => outcome.status !== "unchanged").length;
			result.outcomes.push(...imported.outcomes);
			result.records.push(...imported.records);
		} catch (error) {
			result.failed.push({
				itemKey: input.zotero.itemKey,
				title: input.record.title,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

export async function executePreparedZoteroImportItem(options: {
	state: PreparedZoteroImportState;
	itemKey: string;
	grant: ConfirmationGrant;
	consent: OperationConsentManager;
	client: ZoteroLocalApiClient;
	store: LiteratureStore;
	readAttachment: (itemKey: string) => Promise<{ sha256?: string }>;
	onComplete: () => void;
}): Promise<ZoteroImportResult> {
	const { state, grant } = options;
	if (
		grant.operationId !== state.view.operation.operationId ||
		grant.manifestFingerprint !== state.view.operation.manifestFingerprint
	) {
		throw new Error("Zotero 导入确认与当前预览不匹配");
	}
	if (!state.started) {
		await options.consent.consume(grant, state.plan);
		state.started = true;
	}
	const inputIndex = state.inputs.findIndex((input) => input.zotero.itemKey === options.itemKey);
	if (inputIndex < 0) throw new Error("该 Zotero 论文不在待导入清单中");
	const input = state.inputs[inputIndex];
	try {
		return await executePreparedZoteroImports({
			inputs: [input],
			collectionSpecs: state.view.collections,
			previewItems: state.view.items,
			serverId: state.view.serverId,
			store: options.store,
			validate: async (candidate) => {
				const current = await options.client.getItem(candidate.zotero.itemKey);
				if (current.version !== candidate.zotero.itemVersion) {
					throw new Error("Zotero 条目在确认后发生了变化");
				}
				if (!candidate.body) return;
				const currentPdf = await options.readAttachment(current.key);
				const expectedHash = createHash("sha256").update(candidate.body).digest("hex");
				if (currentPdf.sha256 !== expectedHash) throw new Error("Zotero PDF 在确认后发生了变化");
			},
		});
	} finally {
		state.inputs.splice(inputIndex, 1);
		if (state.inputs.length === 0) options.onComplete();
	}
}
