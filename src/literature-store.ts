import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mergePaperRecords, samePaperIdentity } from "./literature-identifiers.ts";
import { LiteratureSearchIndex } from "./literature-search-index.ts";
import type {
	CorpusManifest,
	CorpusScope,
	CorpusSearchHit,
	DerivedRecord,
	PaperCuration,
	PaperRecord,
	PaperVersion,
	ReadingStatus,
	ScreeningStatus,
	SearchRun,
} from "./literature-types.ts";

function safeSegment(value: string, label: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
		throw new Error(`${label} must use 1-64 letters, numbers, dots, underscores, or hyphens`);
	}
	return value;
}

export function resolveCorpusRoot(cwd: string, scope: CorpusScope, namespace: string, configuredRoot?: string): string {
	const base = configuredRoot ? resolve(cwd, configuredRoot) : resolve(cwd, ".paper-agent", "corpus");
	return join(base, scope, safeSegment(namespace, "namespace"));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, path);
	} catch (error) {
		try {
			await unlink(temporaryPath);
		} catch {
			// Best-effort cleanup; the primary write error is more useful to the caller.
		}
		throw error;
	}
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

function csvField(value: unknown): string {
	const text = value === undefined || value === null ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function bibKey(record: PaperRecord, index: number): string {
	const author = record.authors[0]?.split(/\s+/).at(-1)?.replace(/\W+/g, "") || "paper";
	return (author + (record.year ?? "nd") + (index + 1)).toLowerCase();
}

function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function uniqueNormalized(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		const key = trimmed.toLowerCase();
		if (!trimmed || seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	return result;
}

export class LiteratureStore {
	readonly root: string;
	readonly scope: CorpusScope;
	readonly namespace: string;
	private readonly searchIndex: LiteratureSearchIndex;
	private initialized = false;

	constructor(root: string, scope: CorpusScope, namespace: string) {
		this.root = resolve(root);
		this.scope = scope;
		this.namespace = safeSegment(namespace, "namespace");
		this.searchIndex = new LiteratureSearchIndex(join(this.root, "index", "literature.sqlite"));
	}

	private async recordsSignature(): Promise<string> {
		const directory = join(this.root, "records");
		try {
			const [directoryStat, names] = await Promise.all([stat(directory), readdir(directory)]);
			return `${names.filter((name) => name.endsWith(".json")).length}:${Math.trunc(directoryStat.mtimeMs)}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "0:0";
			throw error;
		}
	}

	private async markSearchIndexCurrent(): Promise<void> {
		await this.searchIndex.setRecordsSignature(await this.recordsSignature());
	}

	private recordPath(id: string): string {
		return join(this.root, "records", `${safeSegment(id, "paper id")}.json`);
	}

	private searchRunPath(id: string): string {
		return join(this.root, "search-runs", `${safeSegment(id, "search run id")}.json`);
	}

	async getSearchRun(id: string): Promise<SearchRun | undefined> {
		return readJson<SearchRun>(this.searchRunPath(id));
	}

	async listSearchRuns(): Promise<SearchRun[]> {
		const directory = join(this.root, "search-runs");
		if (!(await pathExists(directory))) return [];
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const runs = await Promise.all(names.map((name) => readJson<SearchRun>(join(directory, name))));
		return runs
			.filter((run): run is SearchRun => Boolean(run))
			.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
	}

	private derivedPath(key: string): string {
		return join(this.root, "derived", `${safeSegment(key, "derived key")}.json`);
	}

	private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.root, { recursive: true });
		const lockPath = join(this.root, ".write.lock");
		const deadline = Date.now() + 15_000;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			let candidate: Awaited<ReturnType<typeof open>> | undefined;
			try {
				candidate = await open(lockPath, "wx");
				await candidate.writeFile(
					JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), namespace: this.namespace }) +
						"\n",
					"utf8",
				);
				handle = candidate;
			} catch (error) {
				if (candidate) {
					try {
						await candidate.close();
					} catch {
						// Preserve the acquisition error.
					}
					try {
						await unlink(lockPath);
					} catch {
						// Stale-lock recovery handles a leftover file.
					}
					throw error;
				}
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
				try {
					const lockStat = await stat(lockPath);
					if (Date.now() - lockStat.mtimeMs > 120_000) {
						await unlink(lockPath);
						continue;
					}
				} catch (lockError) {
					if ((lockError as NodeJS.ErrnoException).code === "ENOENT") {
						if (code === "EEXIST") continue;
						throw error;
					}
					throw lockError;
				}
				if (Date.now() >= deadline) {
					throw new Error(`Timed out waiting for the corpus write lock: ${lockPath}`);
				}
				await delay(50);
			}
		}
		let result: T;
		try {
			result = await operation();
		} catch (error) {
			try {
				await handle.close();
			} catch {
				// Preserve the operation error.
			}
			try {
				await unlink(lockPath);
			} catch {
				// A stale lock is recovered by age on the next writer; do not mask the primary operation result.
			}
			throw error;
		}
		try {
			await handle.close();
		} catch (error) {
			try {
				await unlink(lockPath);
			} catch {
				// Preserve the close error.
			}
			throw error;
		}
		try {
			await unlink(lockPath);
		} catch {
			// A stale lock is recovered by age on the next writer.
		}
		return result;
	}

	private async upsertPaperUnlocked(
		record: PaperRecord,
		identityCandidates?: PaperRecord[],
	): Promise<"created" | "updated" | "unchanged"> {
		const path = this.recordPath(record.id);
		const direct = await readJson<PaperRecord>(path);
		if (direct && !samePaperIdentity(direct, record)) {
			throw new Error(`Paper id collision requires review instead of automatic merge: ${record.id}`);
		}
		const candidates = identityCandidates ?? (await this.listPapers());
		const existing = direct ?? candidates.find((item) => samePaperIdentity(item, record));
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

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await Promise.all([
			mkdir(join(this.root, "records"), { recursive: true }),
			mkdir(join(this.root, "search-runs"), { recursive: true }),
			mkdir(join(this.root, "derived"), { recursive: true }),
			mkdir(join(this.root, "derived-history"), { recursive: true }),
			mkdir(join(this.root, "paper-versions"), { recursive: true }),
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
		return this.withWriteLock(async () => {
			const result = await this.upsertPaperUnlocked(record);
			if (result !== "unchanged") {
				await this.refreshManifestUnlocked();
				await this.markSearchIndexCurrent();
			}
			return result;
		});
	}

	async upsertPapers(
		records: PaperRecord[],
	): Promise<Array<{ record: PaperRecord; status?: "created" | "updated" | "unchanged"; error?: string }>> {
		await this.initialize();
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

	async persistSearchRun(run: SearchRun): Promise<{ created: number; updated: number; unchanged: number }> {
		await this.initialize();
		return this.withWriteLock(async () => {
			const counts = { created: 0, updated: 0, unchanged: 0 };
			const identityCandidates = await this.listPapers();
			for (const record of run.results) counts[await this.upsertPaperUnlocked(record, identityCandidates)]++;
			await writeJsonAtomic(this.searchRunPath(run.id), run);
			await this.refreshManifestUnlocked();
			await this.markSearchIndexCurrent();
			return counts;
		});
	}

	async listPapers(): Promise<PaperRecord[]> {
		const directory = join(this.root, "records");
		if (!(await pathExists(directory))) return [];
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const records = await Promise.all(names.map((name) => readJson<PaperRecord>(join(directory, name))));
		return records.filter((value): value is PaperRecord => value !== undefined);
	}

	async getPaper(id: string): Promise<PaperRecord | undefined> {
		return readJson<PaperRecord>(this.recordPath(id));
	}

	async searchPapers(options: {
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
		offset?: number;
		limit?: number;
		/** Avoid creating or repairing indexes; used by once-mode and explicitly read-only surfaces. */
		readOnly?: boolean;
	}): Promise<CorpusSearchHit[]> {
		if (!options.readOnly) await this.initialize();
		const query = normalizeSearchText(options.query ?? "");
		const terms = query.split(" ").filter((term) => term.length > 1);
		const wantedAuthors = (options.authors ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedVenues = (options.venues ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTags = (options.tags ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedIdentifiers = (options.identifiers ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTypes = (options.types ?? []).map(normalizeSearchText).filter(Boolean);
		const hits: CorpusSearchHit[] = [];
		const indexedCandidates = query && !options.readOnly ? await this.searchIndex.search(query) : [];
		const candidates = query && !options.readOnly
			? (await Promise.all(indexedCandidates.map((candidate) => this.getPaper(candidate.id)))).filter(
					(record): record is PaperRecord => Boolean(record),
				)
			: await this.listPapers();
		for (const record of candidates) {
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
				record.identifiers.pmid,
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
		return hits
			.sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))
			.slice(offset, offset + Math.min(options.limit ?? 100, 500));
	}

	async putDerived(
		record: DerivedRecord,
		options: { replace?: boolean } = {},
	): Promise<"created" | "replaced" | "unchanged"> {
		await this.initialize();
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
		return readJson<DerivedRecord>(this.derivedPath(key));
	}

	async listDerived(options: { paperId?: string; operation?: string } = {}): Promise<DerivedRecord[]> {
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
		await this.withWriteLock(async () => {
			const path = join(this.root, "paper-versions", `${safeSegment(version.paperId, "paper id")}.json`);
			const existing = (await readJson<PaperVersion[]>(path)) ?? [];
			if (!existing.some((item) => item.sha256 === version.sha256 && item.finalUrl === version.finalUrl)) {
				existing.push(version);
				await writeJsonAtomic(path, existing);
			}
		});
	}

	async listPaperVersions(paperId: string): Promise<PaperVersion[]> {
		const path = join(this.root, "paper-versions", `${safeSegment(paperId, "paper id")}.json`);
		return ((await readJson<PaperVersion[]>(path)) ?? []).sort((left, right) =>
			right.retrievedAt.localeCompare(left.retrievedAt),
		);
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

	async promoteTo(
		target: LiteratureStore,
		ids: string[] | undefined,
		contributor: string,
	): Promise<{ promoted: number; missing: string[] }> {
		if (this.scope !== "personal" || target.scope !== "team") {
			throw new Error("Promotion must move records from a personal corpus to a team corpus");
		}
		const records = ids ? await Promise.all(ids.map((id) => this.getPaper(id))) : await this.listPapers();
		const missing = ids?.filter((_id, index) => !records[index]) ?? [];
		const promoted = await target.proposePapers(
			records.filter((record): record is PaperRecord => Boolean(record)),
			contributor,
		);
		return { promoted, missing };
	}

	async proposePapers(records: PaperRecord[], contributor: string): Promise<number> {
		if (this.scope !== "team") throw new Error("Proposals can only be written to a team corpus");
		if (!contributor.trim()) throw new Error("Contributor identity is required");
		await this.initialize();
		let promoted = 0;
		for (const record of records) {
			const existingTarget = await this.getPaper(record.id);
			const reviewed = existingTarget?.curation?.teamReview;
			const proposed: PaperRecord = {
				...record,
				curation: {
					tags: [...(record.curation?.tags ?? [])],
					userNotes: [],
					teamReview:
						reviewed?.status === "team-approved" || reviewed?.status === "team-rejected"
							? reviewed
							: {
									status: "team-proposed",
									proposedBy: contributor.trim(),
									proposedAt: new Date().toISOString(),
								},
				},
			};
			await this.upsertPaper(proposed);
			promoted++;
		}
		return promoted;
	}

	async backupTo(destinationRoot: string): Promise<string> {
		await this.initialize();
		const destinationBase = resolve(destinationRoot);
		const relativeDestination = relative(this.root, destinationBase);
		if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !isAbsolute(relativeDestination))) {
			throw new Error("Backup destination must not be inside the corpus root");
		}
		return this.withWriteLock(async () => {
			const timestamp = new Date()
				.toISOString()
				.replace(/[^0-9]/g, "")
				.slice(0, 14);
			const name = `${this.scope}-${this.namespace}-${timestamp}-${randomUUID().slice(0, 8)}`;
			const temporaryPath = join(destinationBase, `${name}.tmp`);
			const finalPath = join(destinationBase, name);
			await mkdir(destinationBase, { recursive: true });
			await cp(this.root, temporaryPath, {
				recursive: true,
				filter: (source) => source !== join(this.root, ".write.lock"),
			});
			await rename(temporaryPath, finalPath);
			return finalPath;
		});
	}

	async export(
		format: "markdown" | "csv" | "bibtex" | "json",
		filename?: string,
		recordsSnapshot?: PaperRecord[],
	): Promise<string> {
		await this.initialize();
		const records = recordsSnapshot ?? (await this.listPapers());
		let content: string;
		let extension: string;
		if (format === "json") {
			extension = "json";
			content = JSON.stringify(
				{
					schemaVersion: 1,
					scope: this.scope,
					namespace: this.namespace,
					exportedAt: new Date().toISOString(),
					records,
				},
				null,
				2,
			);
		} else if (format === "csv") {
			extension = "csv";
			content = [
				["id", "title", "authors", "year", "venue", "doi", "arxiv_id", "url", "sources"].join(","),
				...records.map((record) =>
					[
						record.id,
						record.title,
						record.authors.join("; "),
						record.year,
						record.venue,
						record.identifiers.doi,
						record.identifiers.arxivId,
						record.links[0]?.url,
						record.provenance.map((item) => item.provider).join("; "),
					]
						.map(csvField)
						.join(","),
				),
			].join("\n");
		} else if (format === "bibtex") {
			extension = "bib";
			content = records
				.map((record, index) => {
					const fields = [
						`  title = {${record.title.replace(/[{}]/g, "")}}`,
						`  author = {${record.authors.join(" and ").replace(/[{}]/g, "")}}`,
						record.year ? `  year = {${record.year}}` : undefined,
						record.venue ? `  booktitle = {${record.venue.replace(/[{}]/g, "")}}` : undefined,
						record.identifiers.doi ? `  doi = {${record.identifiers.doi}}` : undefined,
						record.links[0] ? `  url = {${record.links[0].url}}` : undefined,
					].filter(Boolean);
					return `@misc{${bibKey(record, index)},\n${fields.join(",\n")}\n}`;
				})
				.join("\n\n");
		} else {
			extension = "md";
			content = [
				"# Literature corpus",
				"",
				`Scope: ${this.scope} / ${this.namespace}`,
				"",
				...records.flatMap((record) => [
					`## ${record.title}`,
					"",
					`- Authors: ${record.authors.join(", ") || "unknown"}`,
					`- Year: ${record.year ?? "unknown"}`,
					`- Venue: ${record.venue ?? "unknown"}`,
					`- DOI: ${record.identifiers.doi ?? "none"}`,
					`- URL: ${record.links[0]?.url ?? "none"}`,
					`- Sources: ${record.provenance.map((item) => item.provider).join(", ")}`,
					"",
				]),
			].join("\n");
		}
		const outputName = filename ? safeSegment(filename, "filename") : `literature-${Date.now()}.${extension}`;
		const outputPath = join(this.root, "exports", outputName);
		await writeFile(outputPath, `${content}\n`, "utf8");
		return outputPath;
	}

	async audit(options: { readOnly?: boolean } = {}): Promise<{
		manifest: CorpusManifest;
		recordsMissingPrimaryLink: string[];
		recordsMissingProvenance: string[];
		teamRecordsPendingReview: string[];
	}> {
		const manifest = options.readOnly ? await this.buildManifestSnapshot() : await this.refreshManifest();
		const records = await this.listPapers();
		return {
			manifest,
			recordsMissingPrimaryLink: records.filter((record) => record.links.length === 0).map((record) => record.id),
			recordsMissingProvenance: records
				.filter((record) => record.provenance.length === 0)
				.map((record) => record.id),
			teamRecordsPendingReview: records
				.filter((record) => record.curation?.teamReview?.status === "team-proposed")
				.map((record) => record.id),
		};
	}

	private async buildManifestSnapshot(): Promise<CorpusManifest> {
		const countJson = async (directory: string) => {
			try {
				return (await readdir(directory)).filter((name) => name.endsWith(".json")).length;
			} catch {
				return 0;
			}
		};
		return {
			schemaVersion: 1,
			scope: this.scope,
			namespace: this.namespace,
			updatedAt: new Date().toISOString(),
			recordCount: await countJson(join(this.root, "records")),
			searchRunCount: await countJson(join(this.root, "search-runs")),
			derivedRecordCount: await countJson(join(this.root, "derived")),
		};
	}

	private async refreshManifestUnlocked(): Promise<CorpusManifest> {
		const manifest = await this.buildManifestSnapshot();
		await writeJsonAtomic(join(this.root, "manifest.json"), manifest);
		return manifest;
	}

	async refreshManifest(): Promise<CorpusManifest> {
		await this.initialize();
		return this.withWriteLock(() => this.refreshManifestUnlocked());
	}
}

export function derivedCacheKey(input: {
	inputHashes: string[];
	operation: string;
	pipelineVersion: string;
	modelVersion?: string;
	promptVersion?: string;
	normalizedConfig: unknown;
}): string {
	const stable = JSON.stringify({
		inputHashes: [...input.inputHashes].sort(),
		operation: input.operation,
		pipelineVersion: input.pipelineVersion,
		modelVersion: input.modelVersion ?? null,
		promptVersion: input.promptVersion ?? null,
		normalizedConfig: input.normalizedConfig,
	});
	return createHash("sha256").update(stable).digest("hex");
}
