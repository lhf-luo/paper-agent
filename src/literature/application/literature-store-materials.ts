import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
	ArtifactManifest,
	DerivedRecord,
	PaperCuration,
	PaperRecord,
	PaperVersion,
	ReadingStatus,
	ScreeningStatus,
} from "../domain/literature-types.ts";
import { LiteratureStoreRecords } from "./literature-store-records.ts";
import { pathExists, readJson, safeSegment, uniqueNormalized, writeJsonAtomic } from "./literature-store-support.ts";

export abstract class LiteratureStoreMaterials extends LiteratureStoreRecords {
	async saveArtifactManifest(manifest: ArtifactManifest, paperId?: string): Promise<string> {
		if (!this.personalDatabase) throw new Error("Artifact manifests require a personal SQLite corpus");
		return this.personalDatabase.saveArtifactManifest(manifest, paperId);
	}

	async listArtifactManifests(paperId?: string): Promise<ArtifactManifest[]> {
		if (!this.personalDatabase) return [];
		return this.personalDatabase.listArtifactManifests(paperId);
	}

	async putDerived(
		record: DerivedRecord,
		options: { replace?: boolean } = {},
	): Promise<"created" | "replaced" | "unchanged"> {
		await this.initialize();
		if (this.personalDatabase) return this.personalDatabase.putDerived(record, options.replace ?? false);
		return this.withWriteLock(async () => {
			const existing = await readJson<DerivedRecord>(this.derivedPath(record.key));
			if (existing) {
				if (JSON.stringify(existing) === JSON.stringify(record)) return "unchanged";
				if (!options.replace) {
					throw new Error(`Derived task key collision: ${record.key}; use a new version or configuration`);
				}
				const historyName = `${record.key}-${existing.createdAt.replace(/[^0-9]/g, "").slice(0, 17)}.json`;
				await writeJsonAtomic(join(this.root, "derived-history", historyName), existing);
				await writeJsonAtomic(this.derivedPath(record.key), record);
				await this.refreshManifestUnlocked();
				return "replaced";
			}
			await writeJsonAtomic(this.derivedPath(record.key), record);
			await this.refreshManifestUnlocked();
			return "created";
		});
	}

	async getDerived(key: string): Promise<DerivedRecord | undefined> {
		if (this.personalDatabase) return this.personalDatabase.getDerived(key);
		return readJson<DerivedRecord>(this.derivedPath(key));
	}

	async listDerived(options: { paperId?: string; operation?: string } = {}): Promise<DerivedRecord[]> {
		if (this.personalDatabase) return this.personalDatabase.listDerived(options);
		const directory = join(this.root, "derived");
		if (!(await pathExists(directory))) return [];
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const records = await Promise.all(names.map((name) => readJson<DerivedRecord>(join(directory, name))));
		return records
			.filter((record): record is DerivedRecord => Boolean(record))
			.filter((record) => !options.paperId || record.paperId === options.paperId)
			.filter((record) => !options.operation || record.operation === options.operation)
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async putBlob(data: Uint8Array): Promise<{ sha256: string; path: string; existed: boolean }> {
		if (this.personalDatabase) return this.personalDatabase.putBlob(data);
		const sha256 = createHash("sha256").update(data).digest("hex");
		const path = join(this.root, "blobs", "sha256", sha256.slice(0, 2), sha256);
		const existed = await pathExists(path);
		if (!existed) {
			await mkdir(dirname(path), { recursive: true });
			const temporaryPath = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporaryPath, data, { flag: "wx" });
				await rename(temporaryPath, path);
			} catch (error) {
				try {
					await unlink(temporaryPath);
				} catch {
					// Best-effort cleanup.
				}
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await pathExists(path))) throw error;
				return { sha256, path, existed: true };
			}
		}
		return { sha256, path, existed };
	}

	async savePaperVersion(version: PaperVersion): Promise<void> {
		await this.initialize();
		if (this.personalDatabase) return this.personalDatabase.savePaperVersion(version);
		await this.withWriteLock(async () => {
			const path = join(this.root, "paper-versions", `${safeSegment(version.paperId, "paper id")}.json`);
			const existing = (await readJson<PaperVersion[]>(path)) ?? [];
			if (!existing.some((item) => item.sha256 === version.sha256 && item.finalUrl === version.finalUrl)) {
				existing.push(version);
				await writeJsonAtomic(path, existing);
			}
		});
	}

	async attachMaterialHash(paperId: string, sha256: string): Promise<PaperRecord> {
		if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Material hash must be a SHA-256 value");
		await this.initialize();
		if (this.personalDatabase) {
			const record = await this.personalDatabase.getPaper(paperId);
			if (!record) throw new Error(`Paper not found in corpus: ${paperId}`);
			if (record.materialHashes?.some((value) => value.toLowerCase() === sha256.toLowerCase())) return record;
			const updated = { ...record, materialHashes: [...(record.materialHashes ?? []), sha256.toLowerCase()] };
			await this.personalDatabase.savePaper(updated);
			return updated;
		}
		return this.withWriteLock(async () => {
			const record = await this.getPaper(paperId);
			if (!record) throw new Error(`Paper not found in corpus: ${paperId}`);
			if (record.materialHashes?.some((value) => value.toLowerCase() === sha256.toLowerCase())) return record;
			const updated = { ...record, materialHashes: [...(record.materialHashes ?? []), sha256.toLowerCase()] };
			await writeJsonAtomic(this.recordPath(paperId), updated);
			await this.searchIndex.upsert(updated);
			await this.refreshManifestUnlocked();
			await this.markSearchIndexCurrent();
			return updated;
		});
	}

	async listPaperVersions(paperId: string): Promise<PaperVersion[]> {
		if (this.personalDatabase) return this.personalDatabase.listPaperVersions(paperId);
		const path = join(this.root, "paper-versions", `${safeSegment(paperId, "paper id")}.json`);
		return ((await readJson<PaperVersion[]>(path)) ?? []).sort((left, right) =>
			right.retrievedAt.localeCompare(left.retrievedAt),
		);
	}

	async readPaperVersionBlob(paperId: string, sha256: string): Promise<Buffer> {
		if (this.personalDatabase) return this.personalDatabase.readPaperVersionBlob(paperId, sha256);
		const version = (await this.listPaperVersions(paperId)).find((item) => item.sha256 === sha256);
		if (!version) throw new Error("PDF version was not found in the selected corpus");
		const expectedRoot = resolve(this.root);
		const blobPath = resolve(version.blobPath);
		const relativeBlobPath = relative(expectedRoot, blobPath);
		if (relativeBlobPath.startsWith("..") || isAbsolute(relativeBlobPath)) {
			throw new Error("PDF blob resolves outside the selected corpus");
		}
		return readFile(blobPath);
	}

	async annotatePaper(
		id: string,
		input: {
			author: string;
			tags?: string[];
			note?: string;
			screeningStatus?: ScreeningStatus;
			screeningReason?: string;
			readingStatus?: ReadingStatus;
			readingNote?: string;
		},
	): Promise<PaperRecord> {
		await this.initialize();
		if (this.personalDatabase) {
			const record = await this.personalDatabase.getPaper(id);
			if (!record) throw new Error(`Paper not found in corpus: ${id}`);
			const now = new Date().toISOString();
			const curation: PaperCuration = structuredClone(record.curation ?? { tags: [], userNotes: [] });
			curation.tags = uniqueNormalized([...curation.tags, ...(input.tags ?? [])]);
			if (input.note?.trim()) {
				curation.userNotes.push({
					id: `note-${randomUUID()}`,
					text: input.note.trim(),
					author: input.author,
					createdAt: now,
				});
			}
			if (input.screeningStatus) {
				curation.screening = {
					status: input.screeningStatus,
					reason: input.screeningReason?.trim() || undefined,
					updatedBy: input.author,
					updatedAt: now,
				};
			}
			if (input.readingStatus) {
				curation.reading = {
					status: input.readingStatus,
					note: input.readingNote?.trim() || undefined,
					updatedBy: input.author,
					updatedAt: now,
				};
			}
			const updated = { ...record, curation };
			await this.personalDatabase.savePaper(updated);
			return updated;
		}
		return this.withWriteLock(async () => {
			const record = await this.getPaper(id);
			if (!record) throw new Error(`Paper not found in corpus: ${id}`);
			const now = new Date().toISOString();
			const curation: PaperCuration = record.curation ?? { tags: [], userNotes: [] };
			curation.tags = uniqueNormalized([...curation.tags, ...(input.tags ?? [])]);
			if (input.note?.trim()) {
				curation.userNotes.push({
					id: `note-${randomUUID()}`,
					text: input.note.trim(),
					author: input.author,
					createdAt: now,
				});
			}
			if (input.screeningStatus) {
				curation.screening = {
					status: input.screeningStatus,
					reason: input.screeningReason?.trim() || undefined,
					updatedBy: input.author,
					updatedAt: now,
				};
			}
			if (input.readingStatus) {
				curation.reading = {
					status: input.readingStatus,
					note: input.readingNote?.trim() || undefined,
					updatedBy: input.author,
					updatedAt: now,
				};
			}
			const updated = { ...record, curation };
			await writeJsonAtomic(this.recordPath(id), updated);
			await this.searchIndex.upsert(updated);
			await this.refreshManifestUnlocked();
			await this.markSearchIndexCurrent();
			return updated;
		});
	}

	async reviewTeamPaper(
		id: string,
		decision: "team-approved" | "team-rejected",
		reviewer: string,
		reason?: string,
	): Promise<PaperRecord> {
		if (this.scope !== "team") throw new Error("Team review is only valid in a team corpus");
		await this.initialize();
		return this.withWriteLock(async () => {
			const record = await this.getPaper(id);
			if (!record) throw new Error(`Paper not found in team corpus: ${id}`);
			const curation: PaperCuration = record.curation ?? { tags: [], userNotes: [] };
			curation.teamReview = {
				...curation.teamReview,
				status: decision,
				reviewedBy: reviewer,
				reviewedAt: new Date().toISOString(),
				reason: reason?.trim() || undefined,
			};
			const updated = { ...record, curation };
			await writeJsonAtomic(this.recordPath(id), updated);
			await this.searchIndex.upsert(updated);
			await this.refreshManifestUnlocked();
			await this.markSearchIndexCurrent();
			return updated;
		});
	}
}
