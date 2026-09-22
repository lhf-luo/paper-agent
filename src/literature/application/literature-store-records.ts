import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusSearchHit, PaperRecord, PaperVersion, ScreeningStatus } from "../domain/literature-types.ts";
import { LiteratureStoreLibrary } from "./literature-store-library.ts";
import { normalizeSearchText, safeSegment, writeJsonAtomic } from "./literature-store-support.ts";

export interface PaperSearchOptions {
	query?: string;
	yearFrom?: number;
	yearTo?: number;
	authors?: string[];
	venues?: string[];
	tags?: string[];
	identifiers?: string[];
	screeningStatuses?: ScreeningStatus[];
	types?: string[];
	openAccess?: boolean;
	collectionId?: string;
	offset?: number;
	limit?: number;
	/** Avoid creating or repairing indexes; used by once-mode and explicitly read-only surfaces. */
	readOnly?: boolean;
}

export abstract class LiteratureStoreRecords extends LiteratureStoreLibrary {
	async deletePapers(paperIds: string[]): Promise<{ deleted: string[]; missing: string[]; blobWarnings: string[] }> {
		await this.initialize();
		if (this.personalDatabase) {
			const uniqueIds = [...new Set(paperIds)];
			const existing = new Set((await this.personalDatabase.getPapers(uniqueIds)).map((paper) => paper.id));
			const missing = uniqueIds.filter((id) => !existing.has(id));
			const targets = uniqueIds.filter((id) => existing.has(id));
			const blobWarnings: string[] = [];
			const trashRoot = join(this.personalDatabase.filesRoot, ".trash", `paper-delete-${randomUUID()}`);
			const staged = new Map<string, { source: string; target: string }>();
			await mkdir(trashRoot, { recursive: true });
			try {
				for (const id of targets) {
					const source = join(this.personalDatabase.filesRoot, safeSegment(id, "paper id"));
					const target = join(trashRoot, safeSegment(id, "paper id"));
					try {
						await rename(source, target);
						staged.set(id, { source, target });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				const result = await this.personalDatabase.deletePapers(targets);
				if (result.missing.length) throw new Error(`Papers changed during deletion: ${result.missing.join(", ")}`);
			} catch (error) {
				for (const { source, target } of [...staged.values()].reverse()) {
					await rename(target, source).catch(() => undefined);
				}
				await rm(trashRoot, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
			for (let index = 0; index < targets.length; index += 3) {
				await Promise.all(
					targets.slice(index, index + 3).map(async (id) => {
						const stagedDirectory = staged.get(id)?.target;
						if (!stagedDirectory) return;
						try {
							await rm(stagedDirectory, { recursive: true, force: true });
						} catch (error) {
							blobWarnings.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}),
				);
			}
			try {
				await rm(trashRoot, { recursive: true, force: true });
			} catch (error) {
				blobWarnings.push(`trash cleanup: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { deleted: targets, missing, blobWarnings };
		}
		return this.withWriteLock(async () => {
			const uniqueIds = [...new Set(paperIds)];
			const entries = await Promise.all(
				uniqueIds.map(async (id) => ({
					record: await this.getPaper(id),
					versions: await this.listPaperVersions(id),
				})),
			);
			const missing = uniqueIds.filter((_, index) => !entries[index].record);
			const existing = entries.filter((entry): entry is { record: PaperRecord; versions: PaperVersion[] } =>
				Boolean(entry.record),
			);
			try {
				for (const { record } of existing) {
					await unlink(this.recordPath(record.id));
					try {
						await unlink(join(this.root, "paper-versions", `${safeSegment(record.id, "paper id")}.json`));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					await this.searchIndex.remove(record.id);
				}
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
			} catch (error) {
				for (const { record, versions } of existing) {
					await writeJsonAtomic(this.recordPath(record.id), record);
					if (versions.length) {
						await writeJsonAtomic(
							join(this.root, "paper-versions", `${safeSegment(record.id, "paper id")}.json`),
							versions,
						);
					}
					await this.searchIndex.upsert(record);
				}
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
				throw error;
			}

			const referencedHashes = new Set(
				(await Promise.all((await this.listPapers()).map((record) => this.listPaperVersions(record.id))))
					.flat()
					.map((version) => version.sha256.toLowerCase()),
			);
			const blobWarnings: string[] = [];
			for (const version of existing.flatMap((entry) => entry.versions)) {
				if (referencedHashes.has(version.sha256.toLowerCase())) continue;
				try {
					await unlink(version.blobPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						blobWarnings.push(`${version.sha256}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
			return { deleted: existing.map((entry) => entry.record.id), missing, blobWarnings };
		});
	}

	async searchPapers(options: PaperSearchOptions): Promise<CorpusSearchHit[]> {
		return (await this.searchPapersPage(options)).hits;
	}

	async searchPapersPage(options: PaperSearchOptions): Promise<{
		hits: CorpusSearchHit[];
		total: number;
		offset: number;
		limit: number;
	}> {
		if (!options.readOnly) await this.initialize();
		const query = normalizeSearchText(options.query ?? "");
		const terms = query.split(" ").filter((term) => term.length > 1);
		const wantedAuthors = (options.authors ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedVenues = (options.venues ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTags = (options.tags ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedIdentifiers = (options.identifiers ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTypes = (options.types ?? []).map(normalizeSearchText).filter(Boolean);
		const hits: CorpusSearchHit[] = [];
		const indexedCandidates =
			query && !options.readOnly && !this.personalDatabase ? await this.searchIndex.search(query) : [];
		const candidates =
			query && !options.readOnly && !this.personalDatabase
				? (await Promise.all(indexedCandidates.map((candidate) => this.getPaper(candidate.id)))).filter(
						(record): record is PaperRecord => Boolean(record),
					)
				: await this.listPapers();
		for (const record of candidates) {
			if (options.collectionId === "__uncategorized__" && (record.collectionIds?.length ?? 0) > 0) {
				continue;
			}
			if (
				options.collectionId &&
				options.collectionId !== "__uncategorized__" &&
				!record.collectionIds?.includes(options.collectionId)
			) {
				continue;
			}
			if (options.yearFrom !== undefined && (record.year === undefined || record.year < options.yearFrom)) continue;
			if (options.yearTo !== undefined && (record.year === undefined || record.year > options.yearTo)) continue;
			const authors = record.authors.map(normalizeSearchText);
			if (
				wantedAuthors.length &&
				!wantedAuthors.every((wanted) => authors.some((author) => author.includes(wanted)))
			) {
				continue;
			}
			const venue = normalizeSearchText(record.venue ?? "");
			if (wantedVenues.length && !wantedVenues.some((wanted) => venue.includes(wanted))) continue;
			const publicationType = normalizeSearchText(record.publicationType ?? "");
			if (wantedTypes.length && !wantedTypes.some((wanted) => publicationType.includes(wanted))) continue;
			if (
				options.openAccess !== undefined &&
				!record.links.some((link) => link.openAccess === options.openAccess && link.kind === "pdf")
			) {
				continue;
			}
			const tags = (record.curation?.tags ?? []).map(normalizeSearchText);
			if (wantedTags.length && !wantedTags.every((wanted) => tags.some((tag) => tag === wanted))) continue;
			const identifiers = [
				record.id,
				record.identifiers.doi,
				record.identifiers.arxivId,
				record.identifiers.openAlexId,
				record.identifiers.semanticScholarId,
				record.identifiers.dblpKey,
				record.identifiers.coreId,
				record.identifiers.openCitationsId,
			]
				.filter((value): value is string => Boolean(value))
				.map(normalizeSearchText);
			if (
				wantedIdentifiers.length &&
				!wantedIdentifiers.every((wanted) => identifiers.some((identifier) => identifier.includes(wanted)))
			) {
				continue;
			}
			if (
				options.screeningStatuses?.length &&
				!options.screeningStatuses.includes(record.curation?.screening?.status ?? "unreviewed")
			) {
				continue;
			}

			const fields = new Map<string, { text: string; weight: number }>([
				["title", { text: normalizeSearchText(record.title), weight: 8 }],
				["authors", { text: authors.join(" "), weight: 4 }],
				["venue", { text: venue, weight: 3 }],
				["abstract", { text: normalizeSearchText(record.abstract ?? ""), weight: 1 }],
				["tags", { text: tags.join(" "), weight: 6 }],
				["identifiers", { text: identifiers.join(" "), weight: 12 }],
				[
					"user-notes",
					{
						text: normalizeSearchText(record.curation?.userNotes.map((note) => note.text).join(" ") ?? ""),
						weight: 2,
					},
				],
			]);
			let score = 0;
			const matchedFields: string[] = [];
			const matchedTerms = new Set<string>();
			for (const [field, value] of fields) {
				let fieldMatched = false;
				if (query && value.text.includes(query)) {
					score += value.weight * 3;
					fieldMatched = true;
				}
				for (const term of terms) {
					if (!value.text.includes(term)) continue;
					matchedTerms.add(term);
					score += value.weight;
					fieldMatched = true;
				}
				if (fieldMatched) matchedFields.push(field);
			}
			if (query && matchedTerms.size < Math.max(1, Math.ceil(terms.length / 2))) continue;
			hits.push({ record, score, matchedFields });
		}
		const offset = Math.max(0, options.offset ?? 0);
		const limit = Math.min(options.limit ?? 100, 500);
		const sorted = hits.sort(
			(left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title),
		);
		return { hits: sorted.slice(offset, offset + limit), total: sorted.length, offset, limit };
	}
}
