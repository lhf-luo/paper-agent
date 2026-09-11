import { createHash, randomUUID } from "node:crypto";
import { appendFile, type FileHandle, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	ArtifactManifest,
	DerivedRecord,
	PaperRecord,
	PaperVersion,
} from "../protocol/literature-types.ts";
import type {
	SharedReviewStatus,
	TeamActor,
	TeamArtifactEntry,
	TeamAuditEvent,
	TeamDerivedEntry,
} from "../protocol/team-corpus-types.ts";
import type { TeamLiteratureRepository } from "../domain/team-literature-repository.ts";
import { createTeamBackupBundle, runTeamBackupRestoreDrill } from "./team-backup.ts";
import type { TeamTokenRegistryBackupSnapshot } from "./team-token-registry.ts";

export type {
	SharedReview,
	SharedReviewStatus,
	TeamArtifactEntry,
	TeamAuditEvent,
	TeamDerivedEntry,
} from "../protocol/team-corpus-types.ts";

import {
	readJson,
	safeSegment,
	sanitizeArtifactManifestForTeam,
	stableFingerprint,
	writeJsonAtomic,
} from "./team-knowledge-serialization.ts";

export { sanitizeArtifactManifestForTeam } from "./team-knowledge-serialization.ts";

type AuditActor = TeamActor | string;

function normalizedActor(actor: AuditActor): TeamActor {
	return typeof actor === "string" ? { id: "legacy", name: actor } : actor;
}

/** Stable member id for records; string actors (legacy callers and tests) carry no id. */
function actorId(actor: AuditActor): string | undefined {
	return typeof actor === "string" ? undefined : actor.id;
}

const AUDIT_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read the newest `count` valid audit events without loading the whole log. The file is scanned backwards in
 * fixed-size chunks and only complete lines are decoded, so a multi-byte UTF-8 sequence split across two
 * chunks is never corrupted. Corrupt lines are skipped, exactly as the full-read implementation did.
 */
async function readNewestAuditEvents(path: string, count: number): Promise<TeamAuditEvent[]> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		const events: TeamAuditEvent[] = [];
		const pushLine = (line: Buffer): void => {
			const text = line.toString("utf8").trim();
			if (!text) return;
			try {
				events.push(JSON.parse(text) as TeamAuditEvent);
			} catch {
				/* Skip a corrupt line rather than failing the whole page. */
			}
		};
		let position = (await handle.stat()).size;
		let carry = Buffer.alloc(0);
		while (position > 0 && events.length < count) {
			const length = Math.min(AUDIT_READ_CHUNK_BYTES, position);
			position -= length;
			const chunk = Buffer.alloc(length);
			await handle.read(chunk, 0, length, position);
			const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk;
			// Every complete line ends at a newline; the leading remainder may continue in the previous chunk.
			let end = buffer.length;
			for (let index = buffer.length - 1; index >= 0 && events.length < count; index--) {
				if (buffer[index] !== 0x0a) continue;
				pushLine(buffer.subarray(index + 1, end));
				end = index;
			}
			carry = buffer.subarray(0, end);
		}
		// The first line of the file has no preceding newline.
		if (position === 0 && events.length < count) pushLine(carry);
		return events;
	} finally {
		await handle.close();
	}
}

export class TeamKnowledgeStore {
	readonly literature: TeamLiteratureRepository;
	readonly root: string;
	readonly namespace: string;
	private auditChain: Promise<void> = Promise.resolve();
	private writeChain: Promise<void> = Promise.resolve();

	constructor(root: string, namespace: string, literature: TeamLiteratureRepository) {
		this.root = root;
		this.namespace = namespace;
		this.literature = literature;
	}

	async initialize(): Promise<void> {
		await this.literature.initialize();
		await Promise.all([
			mkdir(join(this.root, "knowledge", "derived"), { recursive: true }),
			mkdir(join(this.root, "knowledge", "artifacts"), { recursive: true }),
			mkdir(join(this.root, "events"), { recursive: true }),
		]);
	}

	private async withWriteOperation<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.writeChain.then(operation, operation);
		this.writeChain = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	async proposePapers(records: PaperRecord[], actor: AuditActor): Promise<number> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const promoted = await this.literature.proposePapers(records, normalizedActor(actor).name, actorId(actor));
			await this.appendAudit(actor, "paper.propose", undefined, { paperIds: records.map((record) => record.id) });
			return promoted;
		});
	}

	async withdrawPapers(paperIds: string[], actor: AuditActor): Promise<string[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const withdrawn = await this.literature.withdrawPapers(paperIds, normalizedActor(actor).name, actorId(actor));
			await this.appendAudit(actor, "paper.withdraw", undefined, { paperIds: withdrawn });
			return withdrawn;
		});
	}

	async reviewPapers(
		paperIds: string[],
		decision: Exclude<SharedReviewStatus, "team-proposed">,
		actor: AuditActor,
		reason?: string,
	): Promise<PaperRecord[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const reviewed: PaperRecord[] = [];
			for (const id of paperIds) reviewed.push(await this.literature.reviewTeamPaper(id, decision, normalizedActor(actor).name, reason));
			await this.appendAudit(actor, "paper.review", undefined, { paperIds, decision, reason });
			return reviewed;
		});
	}

	async appendAudit(
		actor: AuditActor,
		action: string,
		target?: string,
		details?: Record<string, unknown>,
	): Promise<TeamAuditEvent> {
		const normalized = normalizedActor(actor);
		const event: TeamAuditEvent = {
			id: `event-${randomUUID()}`,
			at: new Date().toISOString(),
			actorId: normalized.id,
			actor: normalized.name,
			action,
			target,
			details,
		};
		const append = async () => {
			await mkdir(join(this.root, "events"), { recursive: true });
			await appendFile(join(this.root, "events", "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
		};
		const operation = this.auditChain.then(append, append);
		this.auditChain = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
		return event;
	}

	async listAuditEvents(offset = 0, limit = 100): Promise<{ events: TeamAuditEvent[]; nextCursor?: string }> {
		await this.auditChain;
		const bounded = Math.min(Math.max(limit, 1), 500);
		// Ask for one event beyond the page so `nextCursor` can be decided without counting the whole log.
		const newest = await readNewestAuditEvents(join(this.root, "events", "audit.jsonl"), offset + bounded + 1);
		const events = newest.slice(offset, offset + bounded);
		return { events, nextCursor: newest.length > offset + bounded ? String(offset + events.length) : undefined };
	}

	private derivedPath(key: string): string {
		return join(this.root, "knowledge", "derived", `${safeSegment(key, "derived key")}.json`);
	}

	async proposeDerived(records: DerivedRecord[], actor: AuditActor): Promise<TeamDerivedEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const now = new Date().toISOString();
			const entries: TeamDerivedEntry[] = [];
			for (const record of records) {
				if (!record.key || !record.paperId || !record.operation || !Array.isArray(record.inputHashes))
					throw new Error("Invalid derived record");
				const existing = await readJson<TeamDerivedEntry>(this.derivedPath(record.key));
				const proposedRecord = { ...record, createdBy: normalizedActor(actor).name };
				const unchanged =
					existing &&
					stableFingerprint({ ...existing.record, createdBy: undefined }) ===
						stableFingerprint({ ...proposedRecord, createdBy: undefined });
				const review =
					unchanged && (existing.review.status === "team-approved" || existing.review.status === "team-rejected")
						? existing.review
						: { status: "team-proposed" as const, proposedBy: normalizedActor(actor).name, proposedAt: now };
				const entry = { record: proposedRecord, review };
				await writeJsonAtomic(this.derivedPath(record.key), entry);
				entries.push(entry);
			}
			await this.appendAudit(actor, "derived.propose", undefined, {
				keys: entries.map((entry) => entry.record.key),
			});
			return entries;
		});
	}

	async reviewDerived(
		keys: string[],
		decision: Exclude<SharedReviewStatus, "team-proposed">,
		actor: AuditActor,
		reason?: string,
	): Promise<TeamDerivedEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const reviewed: TeamDerivedEntry[] = [];
			for (const key of keys) {
				const entry = await readJson<TeamDerivedEntry>(this.derivedPath(key));
				if (!entry) throw new Error(`Team derived record not found: ${key}`);
				entry.review = {
					...entry.review,
					status: decision,
					reviewedBy: normalizedActor(actor).name,
					reviewedAt: new Date().toISOString(),
					reason: reason?.trim() || undefined,
				};
				await writeJsonAtomic(this.derivedPath(key), entry);
				reviewed.push(entry);
			}
			await this.appendAudit(actor, "derived.review", undefined, { keys, decision, reason });
			return reviewed;
		});
	}

	async listDerived(options: { paperId?: string; includePending?: boolean } = {}): Promise<TeamDerivedEntry[]> {
		await this.writeChain;
		const names = (await readdir(join(this.root, "knowledge", "derived")).catch(() => [])).filter((name) =>
			name.endsWith(".json"),
		);
		const entries = (
			await Promise.all(
				names.map((name) => readJson<TeamDerivedEntry>(join(this.root, "knowledge", "derived", name))),
			)
		)
			.filter((entry): entry is TeamDerivedEntry => Boolean(entry))
			.filter((entry) => !options.paperId || entry.record.paperId === options.paperId)
			.filter((entry) => options.includePending || entry.review.status === "team-approved");
		return entries.sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
	}

	private artifactPath(paperId: string): string {
		return join(this.root, "knowledge", "artifacts", `${safeSegment(paperId, "paper id")}.json`);
	}

	async proposeArtifact(paperId: string, manifest: ArtifactManifest, actor: AuditActor): Promise<TeamArtifactEntry> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const existing = await readJson<TeamArtifactEntry>(this.artifactPath(paperId));
			const sanitized = sanitizeArtifactManifestForTeam(manifest);
			const unchanged = existing && stableFingerprint(existing.manifest) === stableFingerprint(sanitized);
			const review =
				unchanged && (existing.review.status === "team-approved" || existing.review.status === "team-rejected")
					? existing.review
					: { status: "team-proposed" as const, proposedBy: normalizedActor(actor).name, proposedAt: new Date().toISOString() };
			const entry = { paperId, manifest: sanitized, review };
			await writeJsonAtomic(this.artifactPath(paperId), entry);
			await this.appendAudit(actor, "artifact.propose", paperId, {
				pdfSha256: entry.manifest.pdfSha256,
				candidates: entry.manifest.candidates.length,
			});
			return entry;
		});
	}

	async reviewArtifact(
		paperIds: string[],
		decision: Exclude<SharedReviewStatus, "team-proposed">,
		actor: AuditActor,
		reason?: string,
	): Promise<TeamArtifactEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const reviewed: TeamArtifactEntry[] = [];
			for (const paperId of paperIds) {
				const entry = await readJson<TeamArtifactEntry>(this.artifactPath(paperId));
				if (!entry) throw new Error(`Team artifact manifest not found: ${paperId}`);
				entry.review = {
					...entry.review,
					status: decision,
					reviewedBy: normalizedActor(actor).name,
					reviewedAt: new Date().toISOString(),
					reason: reason?.trim() || undefined,
				};
				await writeJsonAtomic(this.artifactPath(paperId), entry);
				reviewed.push(entry);
			}
			await this.appendAudit(actor, "artifact.review", undefined, { paperIds, decision, reason });
			return reviewed;
		});
	}

	async listArtifacts(includePending = false): Promise<TeamArtifactEntry[]> {
		await this.writeChain;
		const names = (await readdir(join(this.root, "knowledge", "artifacts")).catch(() => [])).filter((name) =>
			name.endsWith(".json"),
		);
		return (
			await Promise.all(
				names.map((name) => readJson<TeamArtifactEntry>(join(this.root, "knowledge", "artifacts", name))),
			)
		)
			.filter((entry): entry is TeamArtifactEntry => Boolean(entry))
			.filter((entry) => includePending || entry.review.status === "team-approved")
			.sort((left, right) => left.paperId.localeCompare(right.paperId));
	}

	async putBlob(
		data: Uint8Array,
		expectedSha256: string,
		actor: AuditActor,
		version?: Omit<PaperVersion, "sha256" | "bytes" | "blobPath">,
	): Promise<{ sha256: string; path: string; existed: boolean }> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error("Expected SHA-256 is invalid");
			const actual = createHash("sha256").update(data).digest("hex");
			if (actual !== expectedSha256.toLowerCase())
				throw new Error("Uploaded blob SHA-256 does not match the request path");
			const stored = await this.literature.putBlob(data);
			if (version)
				await this.literature.savePaperVersion({
					...version,
					sha256: stored.sha256,
					bytes: data.byteLength,
					blobPath: stored.path,
				});
			await this.appendAudit(actor, "blob.put", stored.sha256, {
				bytes: data.byteLength,
				paperId: version?.paperId,
				existed: stored.existed,
			});
			return stored;
		});
	}

	async backupTo(destinationRoot: string, security: TeamTokenRegistryBackupSnapshot, actor: AuditActor) {
		await this.initialize();
		return this.withWriteOperation(async () => {
			await this.appendAudit(actor, "backup.create", this.namespace);
			return createTeamBackupBundle({
				namespaceRoot: this.root,
				namespace: this.namespace,
				destinationRoot,
				security,
			});
		});
	}

	async restoreDrill(backupPath: string, drillRoot: string, actor: AuditActor) {
		const result = await runTeamBackupRestoreDrill(backupPath, drillRoot);
		await this.appendAudit(actor, "backup.restore-drill", backupPath, {
			validated: result.validated,
			namespace: result.namespace,
		});
		return result;
	}

	async readBlob(sha256: string): Promise<{ body: Buffer; contentType: string }> {
		if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Blob SHA-256 is invalid");
		const path = join(this.root, "blobs", "sha256", sha256.slice(0, 2), sha256);
		const body = await readFile(path);
		const versions = await readdir(join(this.root, "paper-versions")).catch(() => []);
		let contentType = "application/octet-stream";
		for (const name of versions) {
			const entries = await readJson<PaperVersion[]>(join(this.root, "paper-versions", name));
			const match = entries?.find((entry) => entry.sha256 === sha256);
			if (match) {
				contentType = match.contentType;
				break;
			}
		}
		return { body, contentType };
	}

	async stats() {
		const [audit, derived, artifacts, corpusAudit] = await Promise.all([
			this.listAuditEvents(0, 1),
			this.listDerived({ includePending: true }),
			this.listArtifacts(true),
			this.literature.audit({ readOnly: true }),
		]);
		const blobRoot = join(this.root, "blobs", "sha256");
		let blobCount = 0;
		let blobBytes = 0;
		for (const prefix of await readdir(blobRoot).catch(() => [])) {
			for (const name of await readdir(join(blobRoot, prefix)).catch(() => [])) {
				const value = await stat(join(blobRoot, prefix, name));
				if (value.isFile()) {
					blobCount++;
					blobBytes += value.size;
				}
			}
		}
		return {
			manifest: corpusAudit.manifest,
			pendingPapers: corpusAudit.teamRecordsPendingReview.length,
			derivedCount: derived.length,
			pendingDerived: derived.filter((entry) => entry.review.status === "team-proposed").length,
			artifactCount: artifacts.length,
			pendingArtifacts: artifacts.filter((entry) => entry.review.status === "team-proposed").length,
			blobCount,
			blobBytes,
			latestAuditEvent: audit.events[0],
		};
	}
}
