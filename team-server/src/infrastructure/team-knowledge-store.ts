import { createHash, randomUUID } from "node:crypto";
import { appendFile, type FileHandle, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactManifest, DerivedRecord, PaperRecord, PaperVersion } from "../protocol/literature-types.ts";
import type {
	SharedReviewStatus,
	SharedReview,
	TeamActor,
	TeamArtifactEntry,
	TeamAuditEvent,
	TeamDerivedEntry,
	TeamPageEntry,
	TeamPageSnapshot,
	TeamReviewResource,
	TeamReviewSnapshot,
	TeamReviewVersions,
} from "../protocol/team-corpus-types.ts";
import { TeamStateError } from "../domain/team-state-error.ts";
import { ReviewedContentRepository } from "./reviewed-content-repository.ts";
import { TeamCollaborationRepository } from "./team-collaboration-repository.ts";
import { samePaperIdentity } from "../domain/literature-identifiers.ts";
import { storeTeamBlobStream } from "./team-blob-stream.ts";
import { recoverTeamWrites, runTeamWrite, stageTeamAuditEvent } from "./team-write-journal.ts";
import type { TeamLiteratureRepository } from "../domain/team-literature-repository.ts";
import { createTeamBackupBundle, runTeamBackupRestoreDrill } from "./team-backup.ts";
import type { TeamTokenRegistryBackupSnapshot } from "./team-token-registry.ts";

export type {
	SharedReview,
	SharedReviewStatus,
	TeamArtifactEntry,
	TeamAuditEvent,
	TeamDerivedEntry,
	TeamPageEntry,
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
 * The page review fingerprint covers exactly the content a decision vouches for: source identity, kind,
 * title, markdown body, the author-side content hash, revision, and linked paper ids. Bookkeeping fields
 * (`createdAt`, `createdBy`) are excluded so re-proposing identical content never resets a decision.
 */
function pageFingerprint(snapshot: TeamPageSnapshot): Record<string, unknown> {
	return {
		kind: snapshot.kind,
		sourceId: snapshot.sourceId,
		title: snapshot.title,
		markdown: snapshot.markdown,
		contentHash: snapshot.contentHash,
		revision: snapshot.revision,
		paperIds: snapshot.paperIds,
	};
}

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
	readonly derived: ReviewedContentRepository<TeamDerivedEntry>;
	readonly pages: ReviewedContentRepository<TeamPageEntry>;
	readonly artifacts: ReviewedContentRepository<TeamArtifactEntry>;
	readonly collaboration: TeamCollaborationRepository;

	constructor(root: string, namespace: string, literature: TeamLiteratureRepository) {
		this.root = root;
		this.namespace = namespace;
		this.literature = literature;
		this.derived = new ReviewedContentRepository(join(root, "knowledge", "derived"));
		this.pages = new ReviewedContentRepository(join(root, "knowledge", "pages"));
		this.artifacts = new ReviewedContentRepository(join(root, "knowledge", "artifacts"));
		this.collaboration = new TeamCollaborationRepository(root);
	}

	async initialize(): Promise<void> {
		await this.literature.initialize();
		await Promise.all([
			mkdir(join(this.root, "knowledge", "derived"), { recursive: true }),
			mkdir(join(this.root, "knowledge", "artifacts"), { recursive: true }),
			mkdir(join(this.root, "knowledge", "pages"), { recursive: true }),
			mkdir(join(this.root, "events"), { recursive: true }),
		]);
	}

	async withWriteOperation<T>(operation: () => Promise<T>, mutating = true): Promise<T> {
		const execute = async () => {
			try {
				if (mutating) return await runTeamWrite(this.root, operation);
				await recoverTeamWrites(this.root);
				return await operation();
			} catch (error) {
				this.literature.invalidate?.();
				throw error;
			}
		};
		const pending = this.writeChain.then(execute, execute);
		this.writeChain = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	async recover(): Promise<void> {
		await this.withWriteOperation(async () => {
			this.literature.invalidate?.();
		}, false);
	}

	async proposePapers(records: PaperRecord[], actor: AuditActor): Promise<number> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const promoted = await this.literature.proposePapers(records, normalizedActor(actor).name, actorId(actor));
			const papers = await this.literature.listPapers();
			const ids = [
				...new Set(
					records.flatMap((record) => {
						const found = papers.find((paper) => paper.id === record.id || samePaperIdentity(paper, record));
						return found ? [found.id] : [];
					}),
				),
			];
			for (const snapshot of await this.reviewSnapshots("papers", ids))
				await this.collaboration.record(snapshot, normalizedActor(actor));
			await this.appendAudit(actor, "paper.propose", undefined, { paperIds: records.map((record) => record.id) });
			return promoted;
		});
	}

	async withdrawPapers(
		paperIds: string[],
		actor: AuditActor,
		expectedVersions?: TeamReviewVersions,
	): Promise<string[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			if (expectedVersions) await this.assertReviewVersions("papers", paperIds, expectedVersions);
			const snapshots = await this.reviewSnapshots("papers", paperIds);
			const withdrawn = await this.literature.withdrawPapers(paperIds, normalizedActor(actor).name, actorId(actor));
			for (const snapshot of snapshots)
				await this.collaboration.record(snapshot, normalizedActor(actor), "withdrawn");
			await this.appendAudit(actor, "paper.withdraw", undefined, { paperIds: withdrawn });
			return withdrawn;
		});
	}

	async reviewPapers(
		paperIds: string[],
		decision: Exclude<SharedReviewStatus, "team-proposed">,
		actor: AuditActor,
		reason?: string,
		expectedVersions?: TeamReviewVersions,
		outcome?: "changes-requested",
	): Promise<PaperRecord[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			await this.assertReviewVersions("papers", paperIds, expectedVersions);
			const snapshots = await this.reviewSnapshots("papers", paperIds);
			const reviewed: PaperRecord[] = [];
			for (const id of paperIds)
				reviewed.push(await this.literature.reviewTeamPaper(id, decision, normalizedActor(actor).name, reason));
			for (const snapshot of snapshots)
				await this.collaboration.record(
					snapshot,
					normalizedActor(actor),
					outcome ?? (decision === "team-approved" ? "approved" : "rejected"),
					reason,
				);
			await this.appendAudit(actor, "paper.review", undefined, {
				paperIds,
				decision,
				reason,
				versions: expectedVersions,
			});
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
		if (await stageTeamAuditEvent(this.root, event)) return event;
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

	async reviewSnapshots(resource: TeamReviewResource, ids: string[]): Promise<TeamReviewSnapshot[]> {
		const snapshots: TeamReviewSnapshot[] = [];
		for (const id of ids) {
			let content: unknown;
			let approvedContent: unknown;
			let title = id;
			if (resource === "papers") {
				const record = await this.literature.getReviewablePaper(id);
				if (!record) throw new TeamStateError(404, "Team entry not found");
				const versions = (await this.literature.listPaperVersions(id)).map(
					({ blobPath: _path, ...version }) => version,
				);
				content = { record, versions };
				title = record.title;
				if (record.curation?.teamReview?.revision) approvedContent = await this.literature.getPaper(id);
			} else {
				const state =
					resource === "derived"
						? await this.derived.get(id)
						: resource === "pages"
							? await this.pages.get(id)
							: await this.artifacts.get(id);
				if (!state) throw new TeamStateError(404, "Team entry not found");
				content = state.latest;
				approvedContent = state.latest.review.revision ? state.published : undefined;
				if ("snapshot" in state.latest) title = state.latest.snapshot.title;
				else if ("record" in state.latest) title = state.latest.record.operation;
			}
			snapshots.push({
				resource,
				id,
				title,
				content,
				approvedContent,
				version: stableFingerprint({ resource, id, content, approvedContent }),
			});
		}
		return snapshots;
	}

	async previewReview(resource: TeamReviewResource, ids: string[]): Promise<TeamReviewSnapshot[]> {
		return this.withWriteOperation(() => this.reviewSnapshots(resource, ids), false);
	}

	async assertReviewVersions(
		resource: TeamReviewResource,
		ids: string[],
		expected?: TeamReviewVersions,
	): Promise<void> {
		if (!expected || ids.some((id) => !expected[id]))
			throw new TeamStateError(428, "A preview version is required for every review target");
		const snapshots = await this.reviewSnapshots(resource, ids);
		if (snapshots.some((entry) => expected[entry.id] !== entry.version)) {
			throw new TeamStateError(
				409,
				"Team content changed since the review preview; reload and review the current version",
			);
		}
	}

	async proposeDerived(records: DerivedRecord[], actor: AuditActor): Promise<TeamDerivedEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			for (const record of records) safeSegment(record.key, "derived key");
			const entries: TeamDerivedEntry[] = [];
			for (const record of records) {
				entries.push(
					await this.derived.propose(
						record.key,
						{ record: { ...record, createdBy: normalizedActor(actor).name } },
						normalizedActor(actor),
						(entry) => ({ ...entry.record, createdBy: undefined, createdAt: undefined }),
					),
				);
			}
			await this.appendAudit(actor, "derived.propose", undefined, {
				keys: entries.map((entry) => entry.record.key),
			});
			for (const snapshot of await this.reviewSnapshots(
				"derived",
				entries.map((entry) => entry.record.key),
			))
				await this.collaboration.record(snapshot, normalizedActor(actor));
			return entries;
		});
	}

	async reviewDerived(
		keys: string[],
		decision: "team-approved" | "team-rejected",
		actor: AuditActor,
		reason?: string,
		expectedVersions?: TeamReviewVersions,
		outcome?: "changes-requested",
	): Promise<TeamDerivedEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			await this.assertReviewVersions("derived", keys, expectedVersions);
			const snapshots = await this.reviewSnapshots("derived", keys);
			const entries: TeamDerivedEntry[] = [];
			for (const key of keys) entries.push(await this.derived.review(key, decision, normalizedActor(actor), reason));
			for (const snapshot of snapshots)
				await this.collaboration.record(
					snapshot,
					normalizedActor(actor),
					outcome ?? (decision === "team-approved" ? "approved" : "rejected"),
					reason,
				);
			await this.appendAudit(actor, "derived.review", undefined, {
				keys,
				decision,
				reason,
				versions: expectedVersions,
			});
			return entries;
		});
	}

	async listDerived(options: { paperId?: string; includePending?: boolean } = {}): Promise<TeamDerivedEntry[]> {
		await this.writeChain;
		return (await this.derived.visible(options.includePending))
			.filter((entry) => !options.paperId || entry.record.paperId === options.paperId)
			.sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
	}

	async proposePages(records: TeamPageSnapshot[], actor: AuditActor): Promise<TeamPageEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const member = normalizedActor(actor);
			const sourceIdentityId = actorId(actor) ?? `legacy:${member.name}`;
			const entries: TeamPageEntry[] = [];
			for (const record of records) {
				const sourceNamespace = record.sourceNamespace ?? "default";
				const origin = { sourceIdentityId, sourceNamespace, kind: record.kind, sourceId: record.sourceId };
				let key = `page-${stableFingerprint(origin).slice(0, 40)}`;
				// Old snapshots remain addressable. Only their original author can adopt a legacy origin.
				const legacyKey = `${record.kind}.${record.sourceId}`;
				if (legacyKey.length <= 128 && sourceNamespace === "default") {
					const legacy = await this.pages.get(legacyKey);
					if (
						legacy &&
						(legacy.latest.snapshot.sourceIdentityId === sourceIdentityId ||
							legacy.latest.review.proposedById === sourceIdentityId)
					)
						key = legacyKey;
				}
				const snapshot = { ...record, ...origin, key, createdBy: member.name };
				entries.push(
					await this.pages.propose(key, { snapshot }, { ...member, id: sourceIdentityId }, (entry) =>
						pageFingerprint(entry.snapshot),
					),
				);
			}
			await this.appendAudit(actor, "page.propose", undefined, { keys: entries.map((entry) => entry.snapshot.key) });
			for (const snapshot of await this.reviewSnapshots(
				"pages",
				entries.map((entry) => entry.snapshot.key),
			))
				await this.collaboration.record(snapshot, normalizedActor(actor));
			return entries;
		});
	}

	async reviewPages(
		keys: string[],
		decision: "team-approved" | "team-rejected",
		actor: AuditActor,
		reason?: string,
		expectedVersions?: TeamReviewVersions,
		outcome?: "changes-requested",
	): Promise<TeamPageEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			await this.assertReviewVersions("pages", keys, expectedVersions);
			const snapshots = await this.reviewSnapshots("pages", keys);
			const entries: TeamPageEntry[] = [];
			for (const key of keys) entries.push(await this.pages.review(key, decision, normalizedActor(actor), reason));
			for (const snapshot of snapshots)
				await this.collaboration.record(
					snapshot,
					normalizedActor(actor),
					outcome ?? (decision === "team-approved" ? "approved" : "rejected"),
					reason,
				);
			await this.appendAudit(actor, "page.review", undefined, {
				keys,
				decision,
				reason,
				versions: expectedVersions,
			});
			return entries;
		});
	}

	async listPages(options: { includePending?: boolean } = {}): Promise<TeamPageEntry[]> {
		await this.writeChain;
		return (await this.pages.visible(options.includePending)).sort((left, right) =>
			left.snapshot.key.localeCompare(right.snapshot.key),
		);
	}

	async proposeArtifact(paperId: string, manifest: ArtifactManifest, actor: AuditActor): Promise<TeamArtifactEntry> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			const sanitized = sanitizeArtifactManifestForTeam(manifest);
			const entry = await this.artifacts.propose(
				paperId,
				{ paperId, manifest: sanitized },
				normalizedActor(actor),
				(item) => item.manifest,
			);
			await this.appendAudit(actor, "artifact.propose", paperId, {
				pdfSha256: sanitized.pdfSha256,
				candidates: sanitized.candidates.length,
			});
			for (const snapshot of await this.reviewSnapshots("artifacts", [paperId]))
				await this.collaboration.record(snapshot, normalizedActor(actor));
			return entry;
		});
	}

	async reviewArtifact(
		paperIds: string[],
		decision: "team-approved" | "team-rejected",
		actor: AuditActor,
		reason?: string,
		expectedVersions?: TeamReviewVersions,
		outcome?: "changes-requested",
	): Promise<TeamArtifactEntry[]> {
		await this.initialize();
		return this.withWriteOperation(async () => {
			await this.assertReviewVersions("artifacts", paperIds, expectedVersions);
			const snapshots = await this.reviewSnapshots("artifacts", paperIds);
			const entries: TeamArtifactEntry[] = [];
			for (const id of paperIds)
				entries.push(await this.artifacts.review(id, decision, normalizedActor(actor), reason));
			for (const snapshot of snapshots)
				await this.collaboration.record(
					snapshot,
					normalizedActor(actor),
					outcome ?? (decision === "team-approved" ? "approved" : "rejected"),
					reason,
				);
			await this.appendAudit(actor, "artifact.review", undefined, {
				paperIds,
				decision,
				reason,
				versions: expectedVersions,
			});
			return entries;
		});
	}

	async listArtifacts(includePending = false): Promise<TeamArtifactEntry[]> {
		await this.writeChain;
		return (await this.artifacts.visible(includePending)).sort((left, right) =>
			left.paperId.localeCompare(right.paperId),
		);
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
			if (version && !(await this.literature.getPaper(version.paperId)))
				throw new TeamStateError(404, "Propose the paper before uploading its attachment");
			const stored = await this.literature.putBlob(data);
			if (version)
				await this.literature.savePaperVersion({
					...version,
					sha256: stored.sha256,
					bytes: data.byteLength,
					blobPath: stored.path,
					teamReview: {
						status: "team-proposed",
						proposedBy: normalizedActor(actor).name,
						proposedById: actorId(actor),
						proposedAt: new Date().toISOString(),
					},
				});
			await this.appendAudit(actor, "blob.put", stored.sha256, {
				bytes: data.byteLength,
				paperId: version?.paperId,
				existed: stored.existed,
			});
			if (version)
				for (const snapshot of await this.reviewSnapshots("papers", [version.paperId]))
					await this.collaboration.record(snapshot, normalizedActor(actor));
			return stored;
		});
	}

	async putBlobStream(
		source: AsyncIterable<Uint8Array>,
		sha256: string,
		maxBytes: number,
		actor: AuditActor,
		version?: Omit<PaperVersion, "sha256" | "bytes" | "blobPath">,
	) {
		await this.initialize();
		if (version && !(await this.literature.getPaper(version.paperId)))
			throw new TeamStateError(404, "Propose the paper before uploading its attachment");
		const stored = await storeTeamBlobStream(this.root, sha256, source, maxBytes);
		return this.withWriteOperation(async () => {
			if (version) {
				if (!(await this.literature.getPaper(version.paperId)))
					throw new TeamStateError(409, "The paper was removed during upload");
				await this.literature.savePaperVersion({
					...version,
					sha256,
					bytes: stored.bytes,
					blobPath: stored.path,
					teamReview: {
						status: "team-proposed",
						proposedBy: normalizedActor(actor).name,
						proposedById: actorId(actor),
						proposedAt: new Date().toISOString(),
					},
				});
				for (const snapshot of await this.reviewSnapshots("papers", [version.paperId]))
					await this.collaboration.record(snapshot, normalizedActor(actor));
			}
			await this.appendAudit(actor, "blob.put", sha256, {
				bytes: stored.bytes,
				paperId: version?.paperId,
				existed: stored.existed,
			});
			return stored;
		});
	}

	async backupTo(destinationRoot: string, security: TeamTokenRegistryBackupSnapshot, actor: AuditActor) {
		await this.initialize();
		return this.withWriteOperation(async () => {
			try {
				await this.appendAudit(actor, "backup.create", this.namespace);
				const result = await createTeamBackupBundle({
					namespaceRoot: this.root,
					namespace: this.namespace,
					destinationRoot,
					security,
				});
				await this.saveMaintenance("backup", {
					status: "succeeded",
					at: new Date().toISOString(),
					backupPath: result.backupPath,
				});
				await this.appendAudit(actor, "backup.succeeded", this.namespace);
				return result;
			} catch (error) {
				await this.saveMaintenance("backup", {
					status: "failed",
					at: new Date().toISOString(),
					message: "备份创建失败，请检查备份目录权限、磁盘容量和服务端日志。",
				});
				await this.appendAudit(actor, "backup.failed", this.namespace);
				throw error;
			}
		}, false);
	}

	async restoreDrill(backupPath: string, drillRoot: string, actor: AuditActor) {
		return this.withWriteOperation(async () => {
			try {
				const result = await runTeamBackupRestoreDrill(backupPath, drillRoot);
				await this.saveMaintenance("restoreDrill", {
					status: "succeeded",
					at: new Date().toISOString(),
					backupPath,
				});
				await this.appendAudit(actor, "backup.restore-drill", backupPath, {
					validated: result.validated,
					namespace: result.namespace,
				});
				return result;
			} catch (error) {
				await this.saveMaintenance("restoreDrill", {
					status: "failed",
					at: new Date().toISOString(),
					message: "备份恢复演练失败，请检查备份完整性和服务端日志。",
				});
				await this.appendAudit(actor, "backup.restore-drill.failed", this.namespace);
				throw error;
			}
		}, false);
	}

	async maintenance(): Promise<
		Record<string, { status: "succeeded" | "failed"; at: string; backupPath?: string; message?: string }>
	> {
		return (await readJson(join(this.root, "maintenance.json"))) ?? {};
	}
	private async saveMaintenance(
		operation: string,
		result: { status: "succeeded" | "failed"; at: string; backupPath?: string; message?: string },
	): Promise<void> {
		await writeJsonAtomic(join(this.root, "maintenance.json"), {
			...(await this.maintenance()),
			[operation]: result,
		});
	}

	async locateBlob(
		sha256: string,
		options: { includePending?: boolean } = {},
	): Promise<{ path: string; bytes: number; contentType: string }> {
		if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Blob SHA-256 is invalid");
		const path = join(this.root, "blobs", "sha256", sha256.slice(0, 2), sha256);
		const versions = await readdir(join(this.root, "paper-versions")).catch(() => []);
		let contentType = "application/octet-stream";
		let visible = Boolean(options.includePending);
		for (const name of versions) {
			if (!name.endsWith(".json")) continue;
			const entries = await readJson<PaperVersion[]>(join(this.root, "paper-versions", name));
			const match = entries?.find(
				(entry) =>
					entry.sha256 === sha256 &&
					(options.includePending || !entry.teamReview || entry.teamReview.status === "team-approved"),
			);
			if (match) {
				const paper = await this.literature.getPaper(match.paperId);
				if (!options.includePending && paper?.curation?.teamReview?.status !== "team-approved") continue;
				visible = true;
				contentType = match.contentType;
				break;
			}
		}
		if (!visible) {
			for (const entry of await this.listArtifacts()) {
				if ((await this.literature.getPaper(entry.paperId))?.curation?.teamReview?.status !== "team-approved")
					continue;
				const acquisition = entry.manifest.acquisitions.find(
					(item) => item.sha256 === sha256 && item.status === "downloaded",
				);
				if (acquisition) {
					visible = true;
					contentType = acquisition.contentType ?? contentType;
					break;
				}
			}
		}
		if (!visible) throw new TeamStateError(404, "Blob not found");
		const info = await stat(path);
		return { path, bytes: info.size, contentType };
	}

	async readBlob(
		sha256: string,
		options: { includePending?: boolean } = {},
	): Promise<{ body: Buffer; contentType: string }> {
		const blob = await this.locateBlob(sha256, options);
		return { body: await readFile(blob.path), contentType: blob.contentType };
	}

	async stats(options: { includePending?: boolean } = {}) {
		return this.withWriteOperation(async () => {
			const corpusAudit = await this.literature.audit({ readOnly: true });
			const publicPapers = (await this.literature.listPapers()).filter(
				(paper) => paper.curation?.teamReview?.status === "team-approved",
			);
			const publicIds = new Set(publicPapers.map((paper) => paper.id));
			const publicHashes = new Set<string>();
			const count = async <T extends { review: SharedReview }>(
				repository: ReviewedContentRepository<T>,
				published?: (entry: T) => void,
			) => {
				let total = 0,
					pending = 0;
				for (const key of await repository.keys()) {
					const state = await repository.get(key);
					if (!state) continue;
					if (options.includePending || state.published) total++;
					if (state.latest.review.status === "team-proposed") pending++;
					if (state.published) published?.(state.published);
				}
				return { total, pending: options.includePending ? pending : undefined };
			};
			const [derived, pages, artifacts, audit] = await Promise.all([
				count(this.derived),
				count(this.pages),
				count(this.artifacts, (entry) => {
					if (!options.includePending && publicIds.has(entry.paperId))
						for (const item of entry.manifest.acquisitions) {
							if (item.status === "downloaded" && item.sha256) publicHashes.add(item.sha256);
						}
				}),
				options.includePending ? this.listAuditEvents(0, 1) : Promise.resolve({ events: [] as TeamAuditEvent[] }),
			]);
			if (!options.includePending)
				for (const paper of publicPapers) {
					for (const version of await this.literature.listPaperVersions(paper.id)) {
						if (!version.teamReview || version.teamReview.status === "team-approved")
							publicHashes.add(version.sha256);
					}
				}
			const blobRoot = join(this.root, "blobs", "sha256");
			let blobCount = 0,
				blobBytes = 0;
			for (const prefix of await readdir(blobRoot).catch(() => []))
				for (const name of await readdir(join(blobRoot, prefix)).catch(() => [])) {
					if (!/^[a-f0-9]{64}$/.test(name) || (!options.includePending && !publicHashes.has(name))) continue;
					const info = await stat(join(blobRoot, prefix, name));
					if (info.isFile()) {
						blobCount++;
						blobBytes += info.size;
					}
				}
			return {
				manifest: {
					...corpusAudit.manifest,
					recordCount: options.includePending ? corpusAudit.manifest.recordCount : publicPapers.length,
				},
				pendingPapers: options.includePending ? corpusAudit.teamRecordsPendingReview.length : undefined,
				derivedCount: derived.total,
				pendingDerived: derived.pending,
				pageCount: pages.total,
				pendingPages: pages.pending,
				artifactCount: artifacts.total,
				pendingArtifacts: artifacts.pending,
				blobCount,
				blobBytes,
				latestAuditEvent: audit.events[0],
			};
		}, false);
	}
}
