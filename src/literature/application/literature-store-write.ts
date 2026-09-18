import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	mergePaperRecords,
	sameLocalPdfMetadataIdentity,
	samePaperIdentity,
} from "../domain/literature-identifiers.ts";
import type { PaperCollection, PaperRecord, PaperVersion, SearchRun } from "../domain/literature-types.ts";
import { withCleanMetadata } from "../domain/paper-title.ts";
import { LiteratureStoreBase } from "./literature-store-base.ts";
import {
	type LocalPaperImportInput,
	type LocalPaperImportOptions,
	type LocalPaperImportResult,
	pathExists,
	readJson,
	safeSegment,
	uniqueNormalized,
	writeJsonAtomic,
} from "./literature-store-support.ts";

function matchesImportedPaper(left: PaperRecord, right: PaperRecord): boolean {
	return samePaperIdentity(left, right) || sameLocalPdfMetadataIdentity(left, right);
}

export abstract class LiteratureStoreWrite extends LiteratureStoreBase {
	private async upsertPaperUnlocked(
		record: PaperRecord,
		identityCandidates?: PaperRecord[],
	): Promise<"created" | "updated" | "unchanged"> {
		const path = this.recordPath(record.id);
		const direct = await readJson<PaperRecord>(path);
		if (direct && !matchesImportedPaper(direct, record)) {
			throw new Error(`Paper id collision requires review instead of automatic merge: ${record.id}`);
		}
		const candidates = identityCandidates ?? (await this.listPapers());
		const existing = direct ?? candidates.find((item) => matchesImportedPaper(item, record));
		const merged = existing ? mergePaperRecords(existing, record) : record;
		const mergedPath = this.recordPath(merged.id);
		if (existing && existing.id === merged.id && JSON.stringify(existing) === JSON.stringify(merged)) {
			return "unchanged";
		}
		await writeJsonAtomic(mergedPath, merged);
		await this.searchIndex.upsert(merged);
		if (existing && existing.id !== merged.id) {
			try {
				await unlink(this.recordPath(existing.id));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await this.searchIndex.remove(existing.id);
		}
		if (identityCandidates) {
			const existingIndex = existing ? identityCandidates.findIndex((item) => item.id === existing.id) : -1;
			if (existingIndex >= 0) identityCandidates.splice(existingIndex, 1, merged);
			else identityCandidates.push(merged);
		}
		return existing ? "updated" : "created";
	}

	protected async snapshotJsonDirectory(name: string): Promise<Map<string, string>> {
		const directory = join(this.root, name);
		const snapshot = new Map<string, string>();
		if (!(await pathExists(directory))) return snapshot;
		for (const filename of (await readdir(directory)).filter((value) => value.endsWith(".json"))) {
			snapshot.set(filename, await readFile(join(directory, filename), "utf8"));
		}
		return snapshot;
	}

	protected async restoreJsonDirectory(name: string, snapshot: Map<string, string>): Promise<void> {
		const directory = join(this.root, name);
		await mkdir(directory, { recursive: true });
		for (const filename of (await readdir(directory)).filter((value) => value.endsWith(".json"))) {
			await unlink(join(directory, filename));
		}
		for (const [filename, content] of snapshot) await writeFile(join(directory, filename), content, "utf8");
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.personalDatabase) {
			await this.personalDatabase.initialize();
			this.initialized = true;
			return;
		}
		await Promise.all([
			mkdir(join(this.root, "records"), { recursive: true }),
			mkdir(join(this.root, "search-runs"), { recursive: true }),
			mkdir(join(this.root, "derived"), { recursive: true }),
			mkdir(join(this.root, "derived-history"), { recursive: true }),
			mkdir(join(this.root, "paper-versions"), { recursive: true }),
			mkdir(join(this.root, "collections"), { recursive: true }),
			mkdir(join(this.root, "blobs", "sha256"), { recursive: true }),
			mkdir(join(this.root, "exports"), { recursive: true }),
			mkdir(join(this.root, "imports"), { recursive: true }),
		]);
		const manifestPath = join(this.root, "manifest.json");
		try {
			await writeFile(
				manifestPath,
				`${JSON.stringify(
					{
						schemaVersion: 1,
						scope: this.scope,
						namespace: this.namespace,
						updatedAt: new Date().toISOString(),
						recordCount: 0,
						searchRunCount: 0,
						derivedRecordCount: 0,
					},
					null,
					2,
				)}\n`,
				{ encoding: "utf8", flag: "wx" },
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await this.searchIndex.ensure(await this.recordsSignature(), () => this.listPapers());
		this.initialized = true;
	}

	async upsertPaper(record: PaperRecord): Promise<"created" | "updated" | "unchanged"> {
		await this.initialize();
		record = withCleanMetadata(record);
		if (this.personalDatabase) {
			const direct = await this.personalDatabase.getPaper(record.id);
			const candidates = await this.personalDatabase.listPapers();
			const existing = direct ?? candidates.find((item) => matchesImportedPaper(item, record));
			const mergedBase = existing ? mergePaperRecords(existing, record) : record;
			const merged = direct ? { ...mergedBase, id: direct.id, title: record.title } : mergedBase;
			if (existing && existing.id === merged.id && JSON.stringify(existing) === JSON.stringify(merged))
				return "unchanged";
			await this.personalDatabase.savePaper(merged, existing?.id);
			return existing ? "updated" : "created";
		}
		return this.withWriteLock(async () => {
			const result = await this.upsertPaperUnlocked(record);
			if (result !== "unchanged") {
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
			}
			return result;
		});
	}

	/** Replaces one existing record after a caller has already preserved personal fields and verified identity. */
	async replacePaperMetadata(record: PaperRecord): Promise<"updated" | "unchanged"> {
		await this.initialize();
		record = withCleanMetadata(record);
		if (this.personalDatabase) {
			const existing = await this.personalDatabase.getPaper(record.id);
			if (!existing) throw new Error(`Paper not found in corpus: ${record.id}`);
			if (JSON.stringify(existing) === JSON.stringify(record)) return "unchanged";
			await this.personalDatabase.savePaper(record, existing.id);
			return "updated";
		}
		return this.withWriteLock(async () => {
			const existing = await readJson<PaperRecord>(this.recordPath(record.id));
			if (!existing) throw new Error(`Paper not found in corpus: ${record.id}`);
			if (JSON.stringify(existing) === JSON.stringify(record)) return "unchanged";
			await writeJsonAtomic(this.recordPath(record.id), record);
			await this.searchIndex.upsert(record);
			await this.refreshManifestUnlocked();
			await this.markSearchIndexCurrent();
			return "updated";
		});
	}

	async upsertPapers(
		records: PaperRecord[],
	): Promise<Array<{ record: PaperRecord; status?: "created" | "updated" | "unchanged"; error?: string }>> {
		await this.initialize();
		records = records.map(withCleanMetadata);
		if (this.personalDatabase) {
			const outcomes: Array<{ record: PaperRecord; status?: "created" | "updated" | "unchanged"; error?: string }> =
				[];
			for (const record of records) {
				try {
					outcomes.push({ record, status: await this.upsertPaper(record) });
				} catch (error) {
					outcomes.push({ record, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return outcomes;
		}
		return this.withWriteLock(async () => {
			const identityCandidates = await this.listPapers();
			const outcomes = [];
			let changed = false;
			for (const record of records) {
				try {
					const status = await this.upsertPaperUnlocked(record, identityCandidates);
					outcomes.push({ record, status });
					if (status !== "unchanged") changed = true;
				} catch (error) {
					outcomes.push({ record, error: error instanceof Error ? error.message : String(error) });
				}
			}
			if (changed) {
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
			}
			return outcomes;
		});
	}

	async importLocalPapersAtomically(
		inputs: LocalPaperImportInput[],
		options: LocalPaperImportOptions,
	): Promise<LocalPaperImportResult> {
		await this.initialize();
		if (this.personalDatabase) {
			const result = await this.personalDatabase.importLocalPapersAtomically(inputs, options);
			return result;
		}
		return this.withWriteLock(async () => {
			const snapshots = {
				records: await this.snapshotJsonDirectory("records"),
				versions: await this.snapshotJsonDirectory("paper-versions"),
				collections: await this.snapshotJsonDirectory("collections"),
				imports: await this.snapshotJsonDirectory("imports"),
			};
			const beforeRecords = await this.listPapers();
			const createdBlobs: string[] = [];
			try {
				let collection: PaperCollection | undefined;
				const collectionName = options.collectionName?.trim();
				if (collectionName) {
					collection = (await this.listCollections()).find(
						(value) => value.name === collectionName && value.parentId === undefined,
					);
					if (!collection) {
						const now = new Date().toISOString();
						collection = {
							id: `col-${randomUUID().slice(0, 12)}`,
							name: collectionName,
							createdAt: now,
							updatedAt: now,
						};
						await writeJsonAtomic(this.collectionPath(collection.id), collection);
					}
				}

				const identityCandidates = await this.listPapers();
				const records: PaperRecord[] = [];
				const outcomes: LocalPaperImportResult["outcomes"] = [];
				for (const input of inputs) {
					const actualHash = input.body ? createHash("sha256").update(input.body).digest("hex") : undefined;
					if (input.body && input.sourcePath) {
						const expectedHash = input.record.materialHashes?.[0]?.toLowerCase();
						if (!expectedHash || expectedHash !== actualHash) {
							throw new Error(`PDF changed after confirmation: ${input.sourcePath}`);
						}
					}
					const prior = identityCandidates.find((candidate) => matchesImportedPaper(candidate, input.record));
					const record = collection
						? {
								...input.record,
								collectionIds: uniqueNormalized([...(input.record.collectionIds ?? []), collection.id]),
							}
						: input.record;
					const status = await this.upsertPaperUnlocked(record, identityCandidates);
					const stored = identityCandidates.find((candidate) => matchesImportedPaper(candidate, record));
					if (!stored) throw new Error(`Imported record was not found after write: ${record.id}`);
					if (input.body && input.sourcePath) {
						const blob = await this.putBlob(input.body);
						if (!blob.existed) createdBlobs.push(blob.path);
						const priorVersions = prior ? await this.listPaperVersions(prior.id) : [];
						const finalUrl = input.sourceUrl ?? new URL(`file:///${input.sourcePath.replaceAll("\\", "/")}`).href;
						const versions = [
							...priorVersions.map((version) => ({ ...version, paperId: stored.id })),
							{
								paperId: stored.id,
								sourceUrl: finalUrl,
								finalUrl,
								retrievedAt: new Date().toISOString(),
								sha256: actualHash!,
								bytes: input.body.length,
								blobPath: blob.path,
								contentType: "application/pdf",
								versionKind: "published",
								isPreferred: true,
							} satisfies PaperVersion,
						].filter(
							(version, index, values) =>
								values.findIndex(
									(candidate) =>
										candidate.sha256 === version.sha256 && candidate.finalUrl === version.finalUrl,
								) === index,
						);
						await writeJsonAtomic(
							join(this.root, "paper-versions", `${safeSegment(stored.id, "paper id")}.json`),
							versions,
						);
						if (prior && prior.id !== stored.id) {
							try {
								await unlink(join(this.root, "paper-versions", `${safeSegment(prior.id, "paper id")}.json`));
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							}
						}
					}
					records.push(stored);
					outcomes.push({ paperId: stored.id, status });
				}
				await writeJsonAtomic(
					join(this.root, "imports", `${safeSegment(options.reportId, "import report id")}.json`),
					options.report,
				);
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
				return { collection, records, outcomes };
			} catch (error) {
				const failedRecords = await this.listPapers();
				await this.restoreJsonDirectory("records", snapshots.records);
				await this.restoreJsonDirectory("paper-versions", snapshots.versions);
				await this.restoreJsonDirectory("collections", snapshots.collections);
				await this.restoreJsonDirectory("imports", snapshots.imports);
				for (const record of failedRecords) await this.searchIndex.remove(record.id);
				for (const record of beforeRecords) await this.searchIndex.upsert(record);
				const cleanupErrors: unknown[] = [];
				for (const path of createdBlobs) {
					try {
						await unlink(path);
					} catch (cleanupError) {
						if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(cleanupError);
					}
				}
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
				if (cleanupErrors.length) {
					throw new AggregateError([error, ...cleanupErrors], "Import failed and blob rollback was incomplete");
				}
				throw error;
			}
		});
	}

	async saveSearchRun(run: SearchRun): Promise<void> {
		await this.initialize();
		if (this.personalDatabase) return this.personalDatabase.saveSearchRun(run);
		return this.withWriteLock(async () => {
			await this.writeSearchRunUnlocked(run);
		});
	}

	async persistSearchRun(run: SearchRun): Promise<{ created: number; updated: number; unchanged: number }> {
		await this.initialize();
		if (this.personalDatabase) {
			const counts = { created: 0, updated: 0, unchanged: 0 };
			for (const record of run.results) counts[await this.upsertPaper(record)]++;
			await this.personalDatabase.saveSearchRun(run);
			return counts;
		}
		return this.withWriteLock(async () => {
			const counts = { created: 0, updated: 0, unchanged: 0 };
			const identityCandidates = await this.listPapers();
			for (const record of run.results) counts[await this.upsertPaperUnlocked(record, identityCandidates)]++;
			await this.writeSearchRunUnlocked(run);
			await this.refreshManifestUnlocked();
			await this.markSearchIndexCurrent();
			return counts;
		});
	}

	protected async writeSearchRunUnlocked(run: SearchRun): Promise<void> {
		await writeJsonAtomic(this.searchRunPath(run.id), run);
		await this.trimSearchRunsUnlocked();
	}

	/** 只保留最近 keep 次搜索运行(按 completedAt 排序), 删除更早的。 */
	protected async trimSearchRunsUnlocked(keep = 30): Promise<void> {
		const directory = join(this.root, "search-runs");
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
		if (names.length <= keep) return;
		const entries: Array<{ name: string; completedAt: string }> = [];
		for (const name of names) {
			try {
				const run = (await readJson<SearchRun>(join(directory, name))) as SearchRun | undefined;
				if (run?.completedAt) entries.push({ name, completedAt: run.completedAt });
				else await unlink(join(directory, name)).catch(() => {});
			} catch {
				await unlink(join(directory, name)).catch(() => {});
			}
		}
		entries.sort((left, right) => (left.completedAt < right.completedAt ? -1 : 1));
		for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
			await unlink(join(directory, entry.name)).catch(() => {});
		}
	}
}
