import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	mergePaperRecords,
	sameLocalPdfMetadataIdentity,
	samePaperIdentity,
	uniquePaperLinks,
} from "../domain/literature-identifiers.ts";
import type { PaperRecord, PaperVersion } from "../domain/literature-types.ts";

import {
	json,
	type PersonalLocalImportInput,
	type PersonalLocalImportOptions,
	type PersonalLocalImportResult,
	safePathSegment,
} from "./personal-database-support.ts";
import { PersonalLegacyCorpusMigration } from "./personal-legacy-corpus-migration.ts";

export abstract class PersonalLocalImportRepository extends PersonalLegacyCorpusMigration {
	async importLocalPapersAtomically(
		inputs: PersonalLocalImportInput[],
		options: PersonalLocalImportOptions,
	): Promise<PersonalLocalImportResult> {
		for (const input of inputs) {
			if (!input.body || !input.sourcePath) continue;
			const actualHash = createHash("sha256").update(input.body).digest("hex");
			const expectedHash = input.record.materialHashes?.[0]?.toLowerCase();
			if (!expectedHash || expectedHash !== actualHash)
				throw new Error(`PDF changed after confirmation: ${input.sourcePath}`);
		}
		await this.initialize();
		const existingRecords = await this.listPapers();
		const workingRecords = [...existingRecords];
		const existingCollections = await this.listCollections();
		const collectionName = options.collectionName?.trim();
		let collection = collectionName
			? existingCollections.find((value) => value.name === collectionName && value.parentId === undefined)
			: undefined;
		if (collectionName && !collection) {
			const now = new Date().toISOString();
			collection = { id: `col-${randomUUID().slice(0, 12)}`, name: collectionName, createdAt: now, updatedAt: now };
		}
		const importedCollections = [...existingCollections];
		const collectionIdByExternalKey = new Map<string, string>();
		for (const spec of [...(options.collectionSpecs ?? [])].sort(
			(left, right) => left.path.length - right.path.length,
		)) {
			const parentId = spec.parentExternalKey ? collectionIdByExternalKey.get(spec.parentExternalKey) : undefined;
			if (spec.parentExternalKey && !parentId) throw new Error(`Zotero collection parent is missing: ${spec.name}`);
			let target = importedCollections.find((value) => value.name === spec.name && value.parentId === parentId);
			if (!target) {
				const now = new Date().toISOString();
				target = {
					id: `col-${randomUUID().slice(0, 12)}`,
					name: spec.name,
					parentId,
					createdAt: now,
					updatedAt: now,
				};
				importedCollections.push(target);
			}
			collectionIdByExternalKey.set(spec.externalKey, target.id);
		}

		const records: PaperRecord[] = [];
		const outcomes: PersonalLocalImportResult["outcomes"] = [];
		const preparedInputs: Array<{ input: PersonalLocalImportInput; record: PaperRecord }> = [];
		for (const input of inputs) {
			const assignedCollectionIds = input.zotero
				? input.zotero.collectionKeys
						.map((key) => collectionIdByExternalKey.get(key))
						.filter((id): id is string => Boolean(id))
				: [];
			const targetCollectionIds = [
				...(input.record.collectionIds ?? []),
				...(collection ? [collection.id] : []),
				...assignedCollectionIds,
			];
			const candidate = targetCollectionIds.length
				? { ...input.record, collectionIds: [...new Set(targetCollectionIds)] }
				: input.record;
			const existing = workingRecords.find(
				(record) => samePaperIdentity(record, candidate) || sameLocalPdfMetadataIdentity(record, candidate),
			);
			const mergedBase = existing ? mergePaperRecords(existing, candidate) : candidate;
			const merged = { ...mergedBase, links: uniquePaperLinks(mergedBase.links) };
			const status = !existing
				? "created"
				: JSON.stringify(existing) === JSON.stringify(merged)
					? "unchanged"
					: "updated";
			if (existing) workingRecords.splice(workingRecords.indexOf(existing), 1, merged);
			else workingRecords.push(merged);
			records.push(merged);
			outcomes.push({ paperId: merged.id, status });
			preparedInputs.push({ input, record: merged });
		}

		const reportDirectory = join(this.legacyRoot, "imports");
		const reportPath = join(reportDirectory, `${safePathSegment(options.reportId, "import-report")}.json`);
		const createdFiles: string[] = [];
		const database = this.open();
		try {
			database.exec("BEGIN IMMEDIATE");
			for (const value of importedCollections.filter(
				(value) => !existingCollections.some((old) => old.id === value.id),
			)) {
				database
					.prepare(
						"INSERT INTO collections(id, namespace_id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(value.id, this.namespace, value.name, value.parentId ?? null, value.createdAt, value.updatedAt);
			}
			if (collection) {
				database
					.prepare(
						"INSERT OR IGNORE INTO collections(id, namespace_id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
					)
					.run(collection.id, this.namespace, collection.name, collection.createdAt, collection.updatedAt);
			}
			for (const { input, record } of preparedInputs) {
				const previous = existingRecords.find(
					(value) => samePaperIdentity(value, input.record) || sameLocalPdfMetadataIdentity(value, input.record),
				);
				const rowId = this.syncPaper(database, record, previous?.id);
				const canonicalRow = database
					.prepare("SELECT paper_id, title, record_json FROM papers WHERE row_id = ?")
					.get(rowId) as { paper_id: string; title: string; record_json: string };
				if (input.zotero) {
					database
						.prepare(`INSERT INTO zotero_item_mappings(
							namespace_id, paper_row_id, server_id, library_id, zotero_item_key,
							item_version, last_direction, last_synced_at
						) VALUES (?, ?, ?, ?, ?, ?, 'zotero-to-personal', ?)
						ON CONFLICT(namespace_id, paper_row_id, server_id, library_id) DO UPDATE SET
							zotero_item_key=excluded.zotero_item_key, item_version=excluded.item_version,
							last_direction=excluded.last_direction, last_synced_at=excluded.last_synced_at`)
						.run(
							this.namespace,
							rowId,
							input.zotero.serverId,
							input.zotero.libraryId,
							input.zotero.itemKey,
							input.zotero.itemVersion,
							new Date().toISOString(),
						);
				}
				if (!input.body || !input.sourcePath) continue;
				const stagingRoot = join(this.filesRoot, ".staging");
				await mkdir(stagingRoot, { recursive: true });
				const stagingPath = join(stagingRoot, `${randomUUID()}.pdf`);
				await writeFile(stagingPath, input.body, { flag: "wx" });
				try {
					const sourceUrl = input.sourceUrl ?? new URL(`file:///${input.sourcePath.replaceAll("\\", "/")}`).href;
					const publicationVersion = this.syncPublicationVersions(
						database,
						rowId,
						JSON.parse(canonicalRow.record_json) as PaperRecord,
						true,
					).find((version) => version.kind === "published");
					const version: PaperVersion = {
						paperId: canonicalRow.paper_id,
						publicationVersionId: publicationVersion?.id,
						sourceUrl,
						finalUrl: sourceUrl,
						retrievedAt: new Date().toISOString(),
						sha256: createHash("sha256").update(input.body).digest("hex"),
						bytes: input.body.byteLength,
						blobPath: stagingPath,
						contentType: "application/pdf",
						versionKind: "published",
						isPreferred: true,
					};
					const prepared = await this.allocateVersionFile(
						database,
						{ row_id: rowId, ...canonicalRow },
						version,
						stagingPath,
					);
					if (input.originalFilename) prepared.originalFilename = input.originalFilename;
					await this.materializeFile(stagingPath, prepared.absolutePath);
					createdFiles.push(prepared.absolutePath);
					this.insertPreparedFile(database, rowId, prepared);
				} catch (error) {
					await unlink(stagingPath).catch(() => {});
					if ((error as NodeJS.ErrnoException).code !== "PAPER_VERSION_EXISTS") throw error;
				}
			}
			await mkdir(reportDirectory, { recursive: true });
			await writeFile(reportPath, `${JSON.stringify(options.report, null, 2)}\n`, { flag: "wx" });
			const now = new Date().toISOString();
			database
				.prepare(`INSERT OR REPLACE INTO import_runs(
				id, namespace_id, status, target_collection_id, started_at, completed_at,
				parsed_count, imported_count, needs_metadata_count, rejected_count, report_json
			) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, 0, 0, ?)`)
				.run(
					options.reportId,
					this.namespace,
					collection?.id ?? null,
					now,
					now,
					inputs.length,
					records.length,
					json(options.report),
				);
			const mappingServerId = inputs.find((input) => input.zotero)?.zotero?.serverId;
			if (mappingServerId) {
				for (const spec of options.collectionSpecs ?? []) {
					const collectionId = collectionIdByExternalKey.get(spec.externalKey);
					if (!collectionId) continue;
					database
						.prepare(`INSERT INTO zotero_collection_mappings(
							namespace_id, collection_id, server_id, library_id, zotero_collection_key,
							collection_version, path_json, last_synced_at
						) VALUES (?, ?, ?, '0', ?, ?, ?, ?)
						ON CONFLICT(namespace_id, collection_id, server_id, library_id) DO UPDATE SET
							zotero_collection_key=excluded.zotero_collection_key,
							collection_version=excluded.collection_version,
							path_json=excluded.path_json, last_synced_at=excluded.last_synced_at`)
						.run(
							this.namespace,
							collectionId,
							mappingServerId,
							spec.externalKey,
							spec.version,
							json(spec.path),
							new Date().toISOString(),
						);
				}
			}
			database.exec("COMMIT");
			return { collection, collections: importedCollections, records, outcomes };
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the import error.
			}
			await unlink(reportPath).catch(() => {});
			for (const path of createdFiles) await unlink(path).catch(() => {});
			throw error;
		} finally {
			database.close();
		}
	}
}
