import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { LiteratureStore } from "../../../literature/application/literature-store.ts";
import { normalizeDoi } from "../../../literature/domain/literature-identifiers.ts";
import type { PaperRecord, PaperVersion } from "../../../literature/domain/literature-types.ts";
import type {
	ConfirmationGrant,
	OperationConsentManager,
	OperationPlan,
} from "../../../shared/application/operation-consent.ts";
import {
	collectionPathsForPaper,
	identifierConflict,
	matchesTitleAndAuthor,
	mergeZoteroIntoPersonal,
	paperRecordFromZotero,
	paperToZoteroData,
	preferredVersion,
	zoteroAuthors,
	zoteroCollectionPaths,
	zoteroItemType,
	zoteroYear,
} from "../domain/zotero-mapping.ts";
import type {
	ZoteroApiItem,
	ZoteroCollectionEntry,
	ZoteroCollectionImportSpec,
	ZoteroExportPreparation,
	ZoteroExportPreviewItem,
	ZoteroExportResult,
	ZoteroImportPreparation,
	ZoteroImportPreviewItem,
	ZoteroImportResult,
	ZoteroItemMapping,
	ZoteroLibraryItem,
	ZoteroStatus,
} from "../domain/zotero-types.ts";
import { ZoteroLocalApiClient, ZoteroLocalApiError } from "../infrastructure/zotero-local-api-client.ts";
import { clearZoteroCredentials, loadZoteroCredentials, saveZoteroCredentials } from "./zotero-credential-store.ts";
import { newestPdfAttachments } from "./zotero-attachment-selection.ts";
import {
	executePreparedZoteroImportItem,
	executePreparedZoteroImports,
	type PreparedZoteroImportState,
} from "./zotero-import-execution.ts";
import { collectionKeysWithAncestors, descendantKeys, matchPersonalPaper, validSelection } from "./zotero-selection.ts";

interface ZoteroIntegrationOptions {
	projectRoot: string;
	consent: OperationConsentManager;
	store: (namespace: string) => LiteratureStore;
	defaultNamespace: string;
}

interface PreparedExportState {
	view: ZoteroExportPreparation;
	plan: OperationPlan;
	records: Array<{ record: PaperRecord; version?: PaperVersion; existing?: ZoteroApiItem }>;
}

export class ZoteroIntegrationService {
	private readonly projectRoot: string;
	private readonly consent: OperationConsentManager;
	private readonly storeForNamespace: (namespace: string) => LiteratureStore;
	private readonly defaultNamespace: string;
	private readonly imports = new Map<string, PreparedZoteroImportState>();
	private readonly exports = new Map<string, PreparedExportState>();

	constructor(options: ZoteroIntegrationOptions) {
		this.projectRoot = options.projectRoot;
		this.consent = options.consent;
		this.storeForNamespace = options.store;
		this.defaultNamespace = options.defaultNamespace;
	}

	private async client(): Promise<ZoteroLocalApiClient> {
		return new ZoteroLocalApiClient(await loadZoteroCredentials(this.projectRoot));
	}

	async status(): Promise<ZoteroStatus> {
		const credentials = await loadZoteroCredentials(this.projectRoot);
		const client = new ZoteroLocalApiClient(credentials);
		const status = await client.status();
		if (status.serverId && credentials.serverId && status.serverId !== credentials.serverId) {
			await clearZoteroCredentials(this.projectRoot);
			return { ...status, writeAuthorized: false, message: "检测到另一套 Zotero 数据库，请重新授权写入" };
		}
		return status;
	}

	async authorize(): Promise<ZoteroStatus> {
		const client = await this.client();
		const status = await client.status();
		if (!status.running || !status.localApiEnabled || !status.serverId) throw new Error(status.message);
		const result = await client.authorize(status.serverId);
		await saveZoteroCredentials(this.projectRoot, { apiKey: result.key, serverId: result.serverId });
		return {
			...status,
			writeAuthorized: true,
			message: result.remember ? "Zotero 已永久授权" : "Zotero 已授权一次写入",
		};
	}

	async collections(): Promise<ZoteroCollectionEntry[]> {
		return (await this.client()).listCollections();
	}

	async items(query?: string): Promise<ZoteroLibraryItem[]> {
		const client = await this.client();
		const [items, collections] = await Promise.all([client.listItems(query), client.listCollections()]);
		return items.map((item) => {
			const authors = zoteroAuthors(item.data);
			const missingFields = [
				...(item.data.title?.trim() ? [] : (["title"] as const)),
				...(authors.length ? [] : (["authors"] as const)),
			];
			return {
				key: item.key,
				version: item.version,
				title: item.data.title?.trim() || "未命名条目",
				authors,
				year: zoteroYear(item.data),
				itemType: item.data.itemType,
				collectionKeys: item.data.collections ?? [],
				collectionPaths: zoteroCollectionPaths(collections, item.data.collections ?? []),
				valid: missingFields.length === 0,
				missingFields,
			};
		});
	}

	private async attachment(client: ZoteroLocalApiClient, item: ZoteroApiItem) {
		const warnings: string[] = [];
		for (const child of newestPdfAttachments(await client.getChildren(item.key))) {
			try {
				const file = await client.readAttachment(child.key);
				return {
					body: file.body,
					path: file.path,
					filename: child.data.filename || basename(file.path),
					sha256: createHash("sha256").update(file.body).digest("hex"),
					warnings,
				};
			} catch (error) {
				warnings.push(error instanceof Error ? error.message : String(error));
			}
		}
		warnings.push("没有可读取的 PDF 附件，仍会导入元数据");
		return { warnings };
	}

	async prepareImport(input: Record<string, unknown>): Promise<ZoteroImportPreparation> {
		const namespace = typeof input.namespace === "string" ? input.namespace : this.defaultNamespace;
		const collectionKeys = validSelection(input.collectionKeys, "collectionKeys");
		const itemKeys = validSelection(input.itemKeys, "itemKeys");
		if (!collectionKeys.length && !itemKeys.length) throw new Error("请至少选择一个 Zotero 分类或论文");
		const client = await this.client();
		const status = await this.status();
		if (!status.localApiEnabled || !status.serverId) throw new Error(status.message);
		const [collections, allItems] = await Promise.all([client.listCollections(), client.listItems()]);
		const selectedCollections = input.includeSubcollections
			? descendantKeys(collections, collectionKeys)
			: new Set(collectionKeys);
		const explicitlySelected = new Set(itemKeys);
		const selectedItems = allItems.filter(
			(item) =>
				explicitlySelected.has(item.key) ||
				(item.data.collections ?? []).some((key) => selectedCollections.has(key)),
		);
		if (!selectedItems.length) throw new Error("所选 Zotero 范围内没有论文");
		const requiredLeafKeys = new Set<string>();
		for (const item of selectedItems) {
			for (const key of item.data.collections ?? []) {
				if (explicitlySelected.has(item.key) || selectedCollections.has(key)) requiredLeafKeys.add(key);
			}
		}
		const requiredKeys = collectionKeysWithAncestors(collections, requiredLeafKeys);
		const specs: ZoteroCollectionImportSpec[] = collections
			.filter((collection) => requiredKeys.has(collection.key))
			.map((collection) => ({
				externalKey: collection.key,
				name: collection.name,
				parentExternalKey: collection.parentKey,
				version: collection.version,
				path: collection.path,
			}));
		const store = this.storeForNamespace(namespace);
		const mappings = await store.listZoteroItemMappings(status.serverId);
		const previews: ZoteroImportPreviewItem[] = [];
		const preparedInputs: PreparedZoteroImportState["inputs"] = [];
		for (const item of selectedItems) {
			const source = paperRecordFromZotero(item, status.serverId);
			const missingFields = [
				...(source.title ? [] : (["title"] as const)),
				...(source.authors.length ? [] : (["authors"] as const)),
			];
			if (missingFields.length) {
				previews.push({
					itemKey: item.key,
					itemVersion: item.version,
					action: "skip",
					collectionPaths: [],
					warnings: [],
					missingFields,
				});
				continue;
			}
			const pdf = await this.attachment(client, item);
			const matched = await matchPersonalPaper(store, item, status.serverId, mappings, pdf.sha256);
			const mergedRecord = matched.existing
				? mergeZoteroIntoPersonal(matched.existing, matched.record)
				: matched.record;
			const record = pdf.sha256
				? { ...mergedRecord, materialHashes: [...new Set([pdf.sha256, ...(mergedRecord.materialHashes ?? [])])] }
				: mergedRecord;
			const leafKeys = (item.data.collections ?? []).filter((key) => requiredLeafKeys.has(key));
			const action = matched.conflict
				? "conflict"
				: !matched.existing
					? "create"
					: JSON.stringify(matched.existing) === JSON.stringify(record) && !pdf.body
						? "unchanged"
						: "update";
			previews.push({
				itemKey: item.key,
				itemVersion: item.version,
				record,
				action,
				collectionPaths: zoteroCollectionPaths(collections, leafKeys),
				pdf: pdf.body ? { filename: pdf.filename!, bytes: pdf.body.length, sha256: pdf.sha256! } : undefined,
				warnings: pdf.warnings,
				conflict: matched.conflict,
			});
			if (!matched.conflict) {
				preparedInputs.push({
					record,
					body: pdf.body,
					sourcePath: pdf.path,
					sourceUrl: `zotero://select/library/items/${item.key}`,
					originalFilename: pdf.filename,
					zotero: {
						serverId: status.serverId,
						libraryId: "0",
						itemKey: item.key,
						itemVersion: item.version,
						collectionKeys: leafKeys,
					},
				});
			}
		}
		const plan: OperationPlan = {
			kind: "personal-corpus-write",
			summary: `从 Zotero 导入 ${preparedInputs.length} 篇论文`,
			targets: (preparedInputs.length ? preparedInputs : selectedItems).map((entry) => ({
				label: "Zotero 论文",
				value: "record" in entry ? entry.record.title : entry.data.title || entry.key,
				risk: "medium",
			})),
			details: {
				namespace,
				serverId: status.serverId,
				items: previews.map((item) => ({
					key: item.itemKey,
					version: item.itemVersion,
					action: item.action,
					pdf: item.pdf?.sha256,
				})),
				collections: specs.map((spec) => ({ key: spec.externalKey, path: spec.path, version: spec.version })),
			},
		};
		const operation = await this.consent.prepare(plan);
		if (operation.kind !== "personal-corpus-write") throw new Error("Zotero 导入确认类型无效");
		const operationView = { ...operation, kind: "personal-corpus-write" as const };
		const view = {
			namespace,
			serverId: status.serverId,
			collections: specs,
			items: previews,
			acceptedCount: preparedInputs.length,
			operation: operationView,
		};
		this.imports.set(operation.operationId, { view, plan, started: false, inputs: preparedInputs });
		return view;
	}

	async executeImportItem(
		operationId: string,
		itemKey: string,
		grant: ConfirmationGrant,
	): Promise<ZoteroImportResult> {
		const prepared = this.imports.get(operationId);
		if (!prepared) throw new Error("Zotero 导入预览已过期，请重新准备");
		const status = await this.status();
		if (status.serverId !== prepared.view.serverId) throw new Error("Zotero 数据库已变化，请重新准备导入");
		const client = await this.client();
		return executePreparedZoteroImportItem({
			state: prepared,
			itemKey,
			grant,
			consent: this.consent,
			client,
			store: this.storeForNamespace(prepared.view.namespace),
			readAttachment: async (key) => this.attachment(client, await client.getItem(key)),
			onComplete: () => this.imports.delete(operationId),
		});
	}

	async executeImport(operationId: string, grant: ConfirmationGrant): Promise<ZoteroImportResult> {
		const prepared = this.imports.get(operationId);
		if (!prepared) throw new Error("Zotero 导入预览已过期，请重新准备");
		await this.consent.consume(grant, prepared.plan);
		try {
			const status = await this.status();
			if (status.serverId !== prepared.view.serverId) throw new Error("Zotero 数据库已变化，请重新准备导入");
			const client = await this.client();
			const store = this.storeForNamespace(prepared.view.namespace);
			return executePreparedZoteroImports({
				inputs: prepared.inputs,
				collectionSpecs: prepared.view.collections,
				previewItems: prepared.view.items,
				serverId: prepared.view.serverId,
				store,
				validate: async (input) => {
					const current = await client.getItem(input.zotero.itemKey);
					if (current.version !== input.zotero.itemVersion) {
						throw new Error("Zotero 条目在确认后发生了变化");
					}
					if (input.body) {
						const currentPdf = await this.attachment(client, current);
						const expectedHash = createHash("sha256").update(input.body).digest("hex");
						if (currentPdf.sha256 !== expectedHash) throw new Error("Zotero PDF 在确认后发生了变化");
					}
				},
			});
		} finally {
			this.imports.delete(operationId);
		}
	}

	async cancelImport(operationId: string): Promise<void> {
		this.imports.delete(operationId);
		await this.consent.cancel(operationId);
	}

	private findZoteroMatch(
		record: PaperRecord,
		items: ZoteroApiItem[],
		mapping?: ZoteroItemMapping,
	): ZoteroApiItem | undefined {
		return (
			(mapping ? items.find((item) => item.key === mapping.itemKey) : undefined) ??
			(record.identifiers.doi
				? items.find((item) => normalizeDoi(item.data.DOI) === normalizeDoi(record.identifiers.doi))
				: undefined) ??
			(record.identifiers.arxivId
				? items.find((item) => item.data.extra?.toLowerCase().includes(record.identifiers.arxivId!.toLowerCase()))
				: undefined)
		);
	}

	private async findZoteroPdfMatch(
		client: ZoteroLocalApiClient,
		store: LiteratureStore,
		items: ZoteroApiItem[],
		paperId: string,
		version?: PaperVersion,
	): Promise<ZoteroApiItem | undefined> {
		if (!version) return undefined;
		const body = await store.readPaperVersionBlob(paperId, version.sha256);
		const md5 = createHash("md5").update(body).digest("hex");
		for (const item of items) {
			const children = await client.getChildren(item.key);
			if (children.some((child) => child.data.md5?.toLowerCase() === md5)) return item;
		}
		return undefined;
	}

	async prepareExport(input: Record<string, unknown>): Promise<ZoteroExportPreparation> {
		const namespace = typeof input.namespace === "string" ? input.namespace : this.defaultNamespace;
		const paperIds = validSelection(input.paperIds, "paperIds");
		if (!paperIds.length) throw new Error("请至少选择一篇个人库论文");
		const status = await this.status();
		if (!status.localApiEnabled || !status.serverId) throw new Error(status.message);
		const client = await this.client();
		const [items, zoteroCollections] = await Promise.all([client.listItems(), client.listCollections()]);
		const store = this.storeForNamespace(namespace);
		const [collections, mappings] = await Promise.all([
			store.listCollections(),
			store.listZoteroItemMappings(status.serverId),
		]);
		const records: PreparedExportState["records"] = [];
		const previews: ZoteroExportPreviewItem[] = [];
		for (const paperId of paperIds) {
			const record = await store.getPaper(paperId);
			if (!record) throw new Error(`个人库中不存在论文：${paperId}`);
			const version = preferredVersion(await store.listPaperVersions(paperId));
			const identifierMatch = this.findZoteroMatch(
				record,
				items,
				mappings.find((mapping) => mapping.paperId === paperId),
			);
			const existing =
				identifierMatch ??
				(await this.findZoteroPdfMatch(client, store, items, paperId, version)) ??
				items.find((item) => matchesTitleAndAuthor(record, paperRecordFromZotero(item, "match")));
			const existingRecord = existing ? paperRecordFromZotero(existing, status.serverId) : undefined;
			const conflict = existingRecord ? identifierConflict(record, existingRecord) : undefined;
			const paths = collectionPathsForPaper(record, collections);
			if (!conflict) records.push({ record, version, existing });
			previews.push({
				paperId,
				title: record.title,
				action: conflict ? "conflict" : existing ? "update" : "create",
				collectionPaths: paths.map((path) => path.map((value) => value.name)),
				pdf: version
					? { filename: basename(version.blobPath), bytes: version.bytes, sha256: version.sha256 }
					: undefined,
				itemKey: existing?.key,
				warnings: version ? [] : ["个人库没有可发送的 PDF"],
				conflict,
			});
		}
		if (!records.length) throw new Error("所选论文均存在标识符冲突，无法自动写入 Zotero");
		const plan: OperationPlan = {
			kind: "personal-corpus-write",
			summary: `将 ${records.length} 篇论文导入 Zotero`,
			targets: previews.map((item) => ({ label: "Zotero 论文", value: item.title, risk: "medium" })),
			details: {
				namespace,
				serverId: status.serverId,
				items: previews.map((item) => ({
					paperId: item.paperId,
					action: item.action,
					itemKey: item.itemKey,
					pdf: item.pdf?.sha256,
				})),
				zoteroCollectionCount: zoteroCollections.length,
			},
		};
		const operation = await this.consent.prepare(plan);
		if (operation.kind !== "personal-corpus-write") throw new Error("Zotero 导出确认类型无效");
		const view = {
			namespace,
			serverId: status.serverId,
			items: previews,
			operation: { ...operation, kind: "personal-corpus-write" as const },
		};
		this.exports.set(operation.operationId, { view, plan, records });
		return view;
	}

	private async ensureCollections(
		client: ZoteroLocalApiClient,
		store: LiteratureStore,
		serverId: string,
		records: PreparedExportState["records"],
	): Promise<Map<string, string>> {
		const [personalCollections, current, mappings] = await Promise.all([
			store.listCollections(),
			client.listCollections(),
			store.listZoteroCollectionMappings(serverId),
		]);
		const neededIds = new Set(records.flatMap(({ record }) => record.collectionIds ?? []));
		const byId = new Map(personalCollections.map((collection) => [collection.id, collection]));
		for (const id of [...neededIds]) {
			let parentId = byId.get(id)?.parentId;
			while (parentId) {
				neededIds.add(parentId);
				parentId = byId.get(parentId)?.parentId;
			}
		}
		const result = new Map<string, string>();
		for (const collection of personalCollections
			.filter((value) => neededIds.has(value.id))
			.sort((a, b) => {
				const depth = (value: typeof a) =>
					collectionPathsForPaper({ collectionIds: [value.id] } as PaperRecord, personalCollections)[0]?.length ??
					0;
				return depth(a) - depth(b);
			})) {
			const mapped = mappings.find((mapping) => mapping.collectionId === collection.id);
			const parentKey = collection.parentId ? result.get(collection.parentId) : undefined;
			let target = mapped ? current.find((value) => value.key === mapped.collectionKey) : undefined;
			target ??= current.find((value) => value.name === collection.name && value.parentKey === parentKey);
			if (!target) {
				const created = Object.values(
					await client.createObjects("collections", [
						{ name: collection.name, parentCollection: parentKey ?? false },
					]),
				)[0];
				if (!created) throw new Error(`Zotero 分类创建失败：${collection.name}`);
				target = { key: created.key, version: created.version, name: collection.name, parentKey, path: [] };
				current.push(target);
			}
			result.set(collection.id, target.key);
			await store.saveZoteroCollectionMapping({
				namespace: store.namespace,
				collectionId: collection.id,
				serverId,
				libraryId: "0",
				collectionKey: target.key,
				collectionVersion: target.version,
				path: collectionPathsForPaper(
					{ collectionIds: [collection.id] } as PaperRecord,
					personalCollections,
				)[0]?.map((value) => value.name) ?? [collection.name],
				lastSyncedAt: new Date().toISOString(),
			});
		}
		return result;
	}

	async executeExport(operationId: string, grant: ConfirmationGrant): Promise<ZoteroExportResult> {
		const prepared = this.exports.get(operationId);
		if (!prepared) throw new Error("Zotero 导出预览已过期，请重新准备");
		await this.consent.consume(grant, prepared.plan);
		const status = await this.status();
		if (!status.writeAuthorized || status.serverId !== prepared.view.serverId)
			throw new Error("Zotero 写入授权不可用，请重新授权");
		const client = await this.client();
		const store = this.storeForNamespace(prepared.view.namespace);
		const collectionKeys = await this.ensureCollections(client, store, prepared.view.serverId, prepared.records);
		const result: ZoteroExportResult = { created: 0, updated: 0, unchanged: 0, failed: [] };
		for (const entry of prepared.records) {
			try {
				const preview = prepared.view.items.find((item) => item.paperId === entry.record.id)!;
				if (preview.conflict) throw new Error(preview.conflict);
				const keys = (entry.record.collectionIds ?? [])
					.map((id) => collectionKeys.get(id))
					.filter((key): key is string => Boolean(key));
				const type = zoteroItemType(entry.record.publicationType);
				const template = entry.existing?.data ?? (await client.itemTemplate(type));
				const data = paperToZoteroData(entry.record, { ...template, itemType: type }, keys);
				let item: ZoteroApiItem;
				let changed = false;
				if (entry.existing) {
					data.key = entry.existing.key;
					data.version = entry.existing.version;
					if (JSON.stringify(data) === JSON.stringify(entry.existing.data)) item = entry.existing;
					else {
						item = await client.updateItem(entry.existing.key, data);
						changed = true;
					}
				} else {
					item = Object.values(await client.createObjects("items", [data]))[0];
					if (!item) throw new Error("Zotero 未返回新建条目");
					result.created++;
				}
				if (entry.version) {
					const body = await store.readPaperVersionBlob(entry.record.id, entry.version.sha256);
					const md5 = createHash("md5").update(body).digest("hex");
					const children = await client.getChildren(item.key);
					if (!children.some((child) => child.data.md5?.toLowerCase() === md5)) {
						await client.uploadPdf(item.key, basename(entry.version.blobPath), body);
						changed = true;
					}
				}
				if (entry.existing) changed ? result.updated++ : result.unchanged++;
				await store.saveZoteroItemMapping({
					namespace: prepared.view.namespace,
					paperId: entry.record.id,
					serverId: prepared.view.serverId,
					libraryId: "0",
					itemKey: item.key,
					itemVersion: item.version,
					lastDirection: "personal-to-zotero",
					lastSyncedAt: new Date().toISOString(),
				});
			} catch (error) {
				if (error instanceof ZoteroLocalApiError && [401, 412].includes(error.status)) {
					await clearZoteroCredentials(this.projectRoot);
				}
				result.failed.push({
					paperId: entry.record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.exports.delete(operationId);
		return result;
	}

	async cancelExport(operationId: string): Promise<void> {
		this.exports.delete(operationId);
		await this.consent.cancel(operationId);
	}
}
