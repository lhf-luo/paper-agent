import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mergePaperRecords, samePaperIdentity } from "../domain/literature-identifiers.ts";
import type { TeamLiteratureRepository } from "../domain/team-literature-repository.ts";
import type {
	CorpusManifest,
	CorpusSearchHit,
	PaperCuration,
	PaperRecord,
	PaperVersion,
	ScreeningStatus,
} from "../protocol/literature-types.ts";
import { readJson, safeSegment, writeJsonAtomic } from "./team-knowledge-serialization.ts";

function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export class FileTeamLiteratureRepository implements TeamLiteratureRepository {
	readonly root: string;
	readonly namespace: string;
	private initialized = false;

	constructor(root: string, namespace: string) {
		this.root = resolve(root);
		this.namespace = namespace;
	}

	private recordPath(id: string): string {
		return join(this.root, "records", `${safeSegment(id, "paper id")}.json`);
	}

	private versionPath(paperId: string): string {
		return join(this.root, "paper-versions", `${safeSegment(paperId, "paper id")}.json`);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
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
		if (!(await pathExists(join(this.root, "manifest.json")))) await this.refreshManifest();
		this.initialized = true;
	}

	async listPapers(): Promise<PaperRecord[]> {
		const directory = join(this.root, "records");
		const names = (await readdir(directory).catch(() => [] as string[]))
			.filter((name) => name.endsWith(".json"))
			.sort();
		const records = await Promise.all(names.map((name) => readJson<PaperRecord>(join(directory, name))));
		return records.filter((record): record is PaperRecord => Boolean(record));
	}

	getPaper(id: string): Promise<PaperRecord | undefined> {
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
	}): Promise<CorpusSearchHit[]> {
		const query = normalizeSearchText(options.query ?? "");
		const terms = query.split(" ").filter((term) => term.length > 1);
		const wantedAuthors = (options.authors ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedVenues = (options.venues ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTags = (options.tags ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedIdentifiers = (options.identifiers ?? []).map(normalizeSearchText).filter(Boolean);
		const wantedTypes = (options.types ?? []).map(normalizeSearchText).filter(Boolean);
		const hits: CorpusSearchHit[] = [];
		for (const record of await this.listPapers()) {
			if (options.yearFrom !== undefined && (record.year === undefined || record.year < options.yearFrom)) continue;
			if (options.yearTo !== undefined && (record.year === undefined || record.year > options.yearTo)) continue;
			const authors = record.authors.map(normalizeSearchText);
			if (wantedAuthors.length && !wantedAuthors.every((wanted) => authors.some((author) => author.includes(wanted))))
				continue;
			const venue = normalizeSearchText(record.venue ?? "");
			if (wantedVenues.length && !wantedVenues.some((wanted) => venue.includes(wanted))) continue;
			const publicationType = normalizeSearchText(record.publicationType ?? "");
			if (wantedTypes.length && !wantedTypes.some((wanted) => publicationType.includes(wanted))) continue;
			if (
				options.openAccess !== undefined &&
				!record.links.some((link) => link.kind === "pdf" && link.openAccess === options.openAccess)
			)
				continue;
			const tags = (record.curation?.tags ?? []).map(normalizeSearchText);
			if (wantedTags.length && !wantedTags.every((wanted) => tags.includes(wanted))) continue;
			const identifiers = [record.id, ...Object.values(record.identifiers)]
				.filter((value): value is string => Boolean(value))
				.map(normalizeSearchText);
			if (
				wantedIdentifiers.length &&
				!wantedIdentifiers.every((wanted) => identifiers.some((identifier) => identifier.includes(wanted)))
			)
				continue;
			if (
				options.screeningStatuses?.length &&
				!options.screeningStatuses.includes(record.curation?.screening?.status ?? "unreviewed")
			)
				continue;

			const fields = new Map<string, { text: string; weight: number }>([
				["title", { text: normalizeSearchText(record.title), weight: 8 }],
				["authors", { text: authors.join(" "), weight: 4 }],
				["venue", { text: venue, weight: 3 }],
				["abstract", { text: normalizeSearchText(record.abstract ?? ""), weight: 1 }],
				["tags", { text: tags.join(" "), weight: 6 }],
				["identifiers", { text: identifiers.join(" "), weight: 12 }],
			]);
			let score = 0;
			const matchedFields: string[] = [];
			const matchedTerms = new Set<string>();
			for (const [field, value] of fields) {
				let matched = false;
				if (query && value.text.includes(query)) {
					score += value.weight * 3;
					matched = true;
				}
				for (const term of terms) {
					if (!value.text.includes(term)) continue;
					matchedTerms.add(term);
					score += value.weight;
					matched = true;
				}
				if (matched) matchedFields.push(field);
			}
			if (query && matchedTerms.size < Math.max(1, Math.ceil(terms.length / 2))) continue;
			hits.push({ record, score, matchedFields });
		}
		const offset = Math.max(0, options.offset ?? 0);
		return hits
			.sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))
			.slice(offset, offset + Math.min(options.limit ?? 100, 500));
	}

	async proposePapers(records: PaperRecord[], contributor: string): Promise<number> {
		if (!contributor.trim()) throw new Error("Contributor identity is required");
		await this.initialize();
		return this.withWriteLock(async () => {
			const candidates = await this.listPapers();
			for (const source of records) {
				const proposed: PaperRecord = {
					...structuredClone(source),
					curation: {
						tags: [...(source.curation?.tags ?? [])],
						userNotes: [],
						teamReview: {
							status: "team-proposed",
							proposedBy: contributor.trim(),
							proposedAt: new Date().toISOString(),
						},
					},
				};
				await this.upsertPaper(proposed, candidates);
			}
			await this.refreshManifest();
			return records.length;
		});
	}

	private async upsertPaper(record: PaperRecord, candidates: PaperRecord[]): Promise<void> {
		const direct = await this.getPaper(record.id);
		if (direct && !samePaperIdentity(direct, record))
			throw new Error(`Paper id collision requires review instead of automatic merge: ${record.id}`);
		const existing = direct ?? candidates.find((candidate) => samePaperIdentity(candidate, record));
		const merged = existing ? mergePaperRecords(existing, record) : record;
		if (!existing || JSON.stringify(existing) !== JSON.stringify(merged)) await writeJsonAtomic(this.recordPath(merged.id), merged);
		if (existing && existing.id !== merged.id) await unlink(this.recordPath(existing.id)).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
		const index = existing ? candidates.findIndex((candidate) => candidate.id === existing.id) : -1;
		if (index >= 0) candidates.splice(index, 1, merged);
		else candidates.push(merged);
	}

	async reviewTeamPaper(
		id: string,
		decision: "team-approved" | "team-rejected",
		reviewer: string,
		reason?: string,
	): Promise<PaperRecord> {
		await this.initialize();
		return this.withWriteLock(async () => {
			const record = await this.getPaper(id);
			if (!record) throw new Error(`Paper not found in team corpus: ${id}`);
			const curation: PaperCuration = structuredClone(record.curation ?? { tags: [], userNotes: [] });
			curation.teamReview = {
				...curation.teamReview,
				status: decision,
				reviewedBy: reviewer,
				reviewedAt: new Date().toISOString(),
				reason: reason?.trim() || undefined,
			};
			const updated = { ...record, curation };
			await writeJsonAtomic(this.recordPath(id), updated);
			await this.refreshManifest();
			return updated;
		});
	}

	async putBlob(data: Uint8Array): Promise<{ sha256: string; path: string; existed: boolean }> {
		await this.initialize();
		const sha256 = createHash("sha256").update(data).digest("hex");
		const path = join(this.root, "blobs", "sha256", sha256.slice(0, 2), sha256);
		const existed = await pathExists(path);
		if (!existed) {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, data, { flag: "wx" });
				await rename(temporary, path);
			} catch (error) {
				await unlink(temporary).catch(() => undefined);
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await pathExists(path))) throw error;
				return { sha256, path, existed: true };
			}
		}
		return { sha256, path, existed };
	}

	async savePaperVersion(version: PaperVersion): Promise<void> {
		await this.initialize();
		await this.withWriteLock(async () => {
			const path = this.versionPath(version.paperId);
			const versions = (await readJson<PaperVersion[]>(path)) ?? [];
			if (!versions.some((item) => item.sha256 === version.sha256 && item.finalUrl === version.finalUrl)) {
				versions.push(version);
				await writeJsonAtomic(path, versions);
			}
		});
	}

	async audit(): Promise<{
		manifest: CorpusManifest;
		recordsMissingPrimaryLink: string[];
		recordsMissingProvenance: string[];
		teamRecordsPendingReview: string[];
	}> {
		const records = await this.listPapers();
		return {
			manifest: await this.buildManifest(),
			recordsMissingPrimaryLink: records.filter((record) => record.links.length === 0).map((record) => record.id),
			recordsMissingProvenance: records.filter((record) => record.provenance.length === 0).map((record) => record.id),
			teamRecordsPendingReview: records
				.filter((record) => record.curation?.teamReview?.status === "team-proposed")
				.map((record) => record.id),
		};
	}

	private async buildManifest(): Promise<CorpusManifest> {
		const countJson = async (directory: string) =>
			(await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).length;
		return {
			schemaVersion: 1,
			scope: "team",
			namespace: this.namespace,
			updatedAt: new Date().toISOString(),
			recordCount: await countJson(join(this.root, "records")),
			searchRunCount: await countJson(join(this.root, "search-runs")),
			derivedRecordCount: await countJson(join(this.root, "derived")),
		};
	}

	private async refreshManifest(): Promise<CorpusManifest> {
		const manifest = await this.buildManifest();
		await writeJsonAtomic(join(this.root, "manifest.json"), manifest);
		return manifest;
	}

	private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.root, { recursive: true });
		const lockPath = join(this.root, ".write.lock");
		const deadline = Date.now() + 15_000;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			try {
				handle = await open(lockPath, "wx");
				await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const lockStat = await stat(lockPath).catch(() => undefined);
				if (!lockStat) continue;
				if (Date.now() - lockStat.mtimeMs > 120_000) {
					await unlink(lockPath);
					continue;
				}
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for the corpus write lock: ${lockPath}`);
				await delay(50);
			}
		}
		try {
			return await operation();
		} finally {
			await handle.close().catch(() => undefined);
			await unlink(lockPath).catch(() => undefined);
		}
	}
}
