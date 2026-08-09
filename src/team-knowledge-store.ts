import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LiteratureStore } from "./literature-store.ts";
import type { ArtifactManifest, ArtifactSnapshot, DerivedRecord, PaperRecord, PaperVersion } from "./literature-types.ts";
import { createTeamBackupBundle, runTeamBackupRestoreDrill } from "./team-backup.ts";
import type { TeamTokenRegistryBackupSnapshot } from "./team-token-registry.ts";

export type SharedReviewStatus = "team-proposed" | "team-approved" | "team-rejected";

export interface SharedReview {
	status: SharedReviewStatus;
	proposedBy: string;
	proposedAt: string;
	reviewedBy?: string;
	reviewedAt?: string;
	reason?: string;
}

export interface TeamDerivedEntry {
	record: DerivedRecord;
	review: SharedReview;
}

export interface TeamArtifactEntry {
	paperId: string;
	manifest: ArtifactManifest;
	review: SharedReview;
}

export interface TeamAuditEvent {
	id: string;
	at: string;
	actor: string;
	action: string;
	target?: string;
	details?: Record<string, unknown>;
}

function safeSegment(value: string, label: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
	return value;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		try {
			await unlink(temporary);
		} catch {
			/* Preserve the write error. */
		}
		throw error;
	}
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function sanitizeSnapshot(snapshot: ArtifactSnapshot): ArtifactSnapshot {
	return {
		...snapshot,
		localPath: undefined,
		metadataFile: snapshot.metadataFile
			? {
					...snapshot.metadataFile,
					name: snapshot.metadataFile.name.split(/[\\/]/).at(-1) ?? snapshot.metadataFile.name,
				}
			: undefined,
		licenseFiles: snapshot.licenseFiles?.map((name) => name.split(/[\\/]/).at(-1) ?? name),
	};
}

function stableFingerprint(value: unknown): string {
	const normalize = (entry: unknown): unknown =>
		Array.isArray(entry)
			? entry.map(normalize)
			: entry && typeof entry === "object"
				? Object.fromEntries(
						Object.entries(entry as Record<string, unknown>)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, child]) => [key, normalize(child)]),
					)
				: entry;
	return createHash("sha256")
		.update(JSON.stringify(normalize(value)))
		.digest("hex");
}

export function sanitizeArtifactManifestForTeam(manifest: ArtifactManifest): ArtifactManifest {
	return {
		...manifest,
		pdfPath: manifest.pdfPath.split(/[\\/]/).at(-1) ?? "paper.pdf",
		candidates: manifest.candidates.map((candidate) => ({
			...candidate,
			sources: candidate.sources.map((source) => ({ ...source, context: source.context?.slice(0, 2_000) })),
		})),
		acquisitions: manifest.acquisitions.map(sanitizeSnapshot),
	};
}

export class TeamKnowledgeStore {
	readonly literature: LiteratureStore;
	readonly root: string;
	readonly namespace: string;
	private auditChain: Promise<void> = Promise.resolve();
	private writeChain: Promise<void> = Promise.resolve();

	constructor(root: string, namespace: string) {
		this.root = root;
		this.namespace = namespace;
		this.literature = new LiteratureStore(root, "team", namespace);
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

	async proposePapers(records: Parameters<LiteratureStore["proposePapers"]>[0], actor: string): Promise<number> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const promoted = await this.literature.proposePapers(records, actor);
			await this.appendAudit(actor, "paper.propose", undefined, { paperIds: records.map((record) => record.id) });
			return promoted;
		});
	}

	async reviewPapers(
		paperIds: string[],
		decision: Exclude<SharedReviewStatus, "team-proposed">,
		actor: string,
		reason?: string,
	): Promise<PaperRecord[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const reviewed: PaperRecord[] = [];
			for (const id of paperIds) reviewed.push(await this.literature.reviewTeamPaper(id, decision, actor, reason));
			await this.appendAudit(actor, "paper.review", undefined, { paperIds, decision, reason });
			return reviewed;
		});
	}

	async appendAudit(
		actor: string,
		action: string,
		target?: string,
		details?: Record<string, unknown>,
	): Promise<TeamAuditEvent> {
		const event: TeamAuditEvent = {
			id: `event-${randomUUID()}`,
			at: new Date().toISOString(),
			actor,
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
		let text = "";
		try {
			text = await readFile(join(this.root, "events", "audit.jsonl"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const all = text
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as TeamAuditEvent];
				} catch {
					return [];
				}
			})
			.reverse();
		const bounded = Math.min(Math.max(limit, 1), 500);
		const events = all.slice(offset, offset + bounded);
		return { events, nextCursor: offset + events.length < all.length ? String(offset + events.length) : undefined };
	}

	private derivedPath(key: string): string {
		return join(this.root, "knowledge", "derived", `${safeSegment(key, "derived key")}.json`);
	}

	async proposeDerived(records: DerivedRecord[], actor: string): Promise<TeamDerivedEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const now = new Date().toISOString();
			const entries: TeamDerivedEntry[] = [];
			for (const record of records) {
				if (!record.key || !record.paperId || !record.operation || !Array.isArray(record.inputHashes))
					throw new Error("Invalid derived record");
				const existing = await readJson<TeamDerivedEntry>(this.derivedPath(record.key));
				const proposedRecord = { ...record, createdBy: actor };
				const unchanged =
					existing &&
					stableFingerprint({ ...existing.record, createdBy: undefined }) ===
						stableFingerprint({ ...proposedRecord, createdBy: undefined });
				const review =
					unchanged && (existing.review.status === "team-approved" || existing.review.status === "team-rejected")
						? existing.review
						: { status: "team-proposed" as const, proposedBy: actor, proposedAt: now };
				const entry = { record: proposedRecord, review };
				await writeJsonAtomic(this.derivedPath(record.key), entry);
				entries.push(entry);
			}
			await this.appendAudit(actor, "derived.propose", undefined, { keys: entries.map((entry) => entry.record.key) });
			return entries;
		});
	}

	async reviewDerived(
		keys: string[],
		decision: Exclude<SharedReviewStatus, "team-proposed">,
		actor: string,
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
					reviewedBy: actor,
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

	async proposeArtifact(paperId: string, manifest: ArtifactManifest, actor: string): Promise<TeamArtifactEntry> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const existing = await readJson<TeamArtifactEntry>(this.artifactPath(paperId));
			const sanitized = sanitizeArtifactManifestForTeam(manifest);
			const unchanged = existing && stableFingerprint(existing.manifest) === stableFingerprint(sanitized);
			const review =
				unchanged && (existing.review.status === "team-approved" || existing.review.status === "team-rejected")
					? existing.review
					: { status: "team-proposed" as const, proposedBy: actor, proposedAt: new Date().toISOString() };
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
		actor: string,
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
					reviewedBy: actor,
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
		actor: string,
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

	async backupTo(destinationRoot: string, security: TeamTokenRegistryBackupSnapshot, actor: string) {
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

	async restoreDrill(backupPath: string, drillRoot: string, actor: string) {
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
