import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TeamStateError } from "../domain/team-state-error.ts";
import type { PaperRecord } from "../protocol/literature-types.ts";
import type {
	SharedReview,
	TeamActor,
	TeamContentRef,
	TeamDiscussion,
	TeamNotification,
	TeamProposalStatus,
	TeamReviewSnapshot,
	TeamSubmission,
	TeamTopic,
	TeamTopicChange,
} from "../protocol/team-corpus-types.ts";
import {
	readJson,
	removeTeamFile,
	safeSegment,
	stableFingerprint,
	writeJsonAtomic,
} from "./team-knowledge-serialization.ts";

export function snapshotReview(snapshot: TeamReviewSnapshot): SharedReview {
	if (snapshot.resource !== "papers") return (snapshot.content as { review: SharedReview }).review;
	const record = (snapshot.content as { record: PaperRecord }).record;
	const review = record.curation?.teamReview;
	return {
		status:
			review?.status === "team-approved"
				? "team-approved"
				: review?.status === "team-rejected"
					? "team-rejected"
					: "team-proposed",
		proposedBy: review?.proposedBy ?? "legacy",
		proposedById: review?.proposedById,
		proposedAt: review?.proposedAt ?? "1970-01-01T00:00:00.000Z",
		reviewedBy: review?.reviewedBy,
		reviewedAt: review?.reviewedAt,
		reason: review?.reason,
		revision: review?.revision,
	};
}

export function sameActor(owner: TeamActor, actor: TeamActor): boolean {
	return owner.id.startsWith("legacy:") ? owner.name === actor.name : owner.id === actor.id;
}

export function submissionFor(snapshot: TeamReviewSnapshot): TeamSubmission {
	const review = snapshotReview(snapshot);
	return {
		resource: snapshot.resource,
		id: snapshot.id,
		title: snapshot.title,
		version: snapshot.version,
		proposedBy: { id: review.proposedById ?? `legacy:${review.proposedBy}`, name: review.proposedBy },
		proposedAt: review.proposedAt,
		updatedAt: review.reviewedAt ?? review.proposedAt,
		status:
			review.status === "team-approved" ? "approved" : review.status === "team-rejected" ? "rejected" : "pending",
		revision: Boolean(review.revision),
		reason: review.reason,
	};
}

/** Feedback metadata is separate from full, immutable content snapshots. All writes join the namespace journal. */
export class TeamCollaborationRepository {
	readonly root: string;
	constructor(root: string) {
		this.root = root;
	}

	private key(ref: TeamContentRef): string {
		return stableFingerprint({ resource: ref.resource, id: ref.id });
	}
	private path(ref: TeamContentRef): string {
		return join(this.root, "collaboration", "entries", `${this.key(ref)}.json`);
	}
	private snapshotPath(ref: TeamContentRef, version: string): string {
		if (!/^[a-f0-9]{64}$/.test(version)) throw new TeamStateError(400, "Invalid content version");
		return join(this.root, "collaboration", "snapshots", this.key(ref), `${version}.json`);
	}
	async get(ref: TeamContentRef): Promise<TeamDiscussion | undefined> {
		return readJson<TeamDiscussion>(this.path(ref));
	}
	async list(): Promise<TeamDiscussion[]> {
		const directory = join(this.root, "collaboration", "entries");
		const entries: TeamDiscussion[] = [];
		for (const name of await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [] as string[];
			throw error;
		})) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			const value = await readJson<TeamDiscussion>(join(directory, name));
			if (value) entries.push(value);
		}
		return entries;
	}
	async snapshot(ref: TeamContentRef, version: string): Promise<TeamReviewSnapshot | undefined> {
		return readJson<TeamReviewSnapshot>(this.snapshotPath(ref, version));
	}
	private async save(value: TeamDiscussion): Promise<TeamDiscussion> {
		const result = { ...value, version: stableFingerprint({ ...value, version: undefined }) };
		await writeJsonAtomic(this.path(value), result);
		return result;
	}
	async record(
		snapshot: TeamReviewSnapshot,
		actor: TeamActor,
		status?: TeamProposalStatus,
		reason?: string,
	): Promise<void> {
		const previous = await this.get(snapshot);
		if (!status && previous?.current.version === snapshot.version) return;
		const review = snapshotReview(snapshot);
		if (!status && previous && review.status !== "team-proposed" && previous.current.proposedAt === review.proposedAt)
			return;
		const current =
			previous?.current.version === snapshot.version ? { ...previous.current } : submissionFor(snapshot);
		const history = previous ? [...previous.history] : [];
		if (previous && previous.current.version !== snapshot.version) {
			history.push({
				...previous.current,
				status: previous.current.status === "pending" ? "superseded" : previous.current.status,
			});
		}
		if (status) {
			current.status = status;
			current.reviewedBy = actor;
			current.reason = reason;
			current.updatedAt = new Date().toISOString();
		}
		await writeJsonAtomic(this.snapshotPath(snapshot, snapshot.version), snapshot);
		await this.save({
			resource: snapshot.resource,
			id: snapshot.id,
			current,
			history,
			comments: previous?.comments ?? [],
			assignedTo: previous?.assignedTo,
			version: "",
		});
		if (status)
			await this.notify(
				current.proposedBy,
				actor,
				snapshot,
				current.title,
				`${status}${reason ? `: ${reason}` : ""}`,
			);
		else if (previous?.assignedTo)
			await this.notify(previous.assignedTo, actor, snapshot, current.title, "提案内容已更新，请重新审阅。");
	}
	async feedback(
		ref: TeamContentRef,
		actor: TeamActor,
		input: { text?: string; assignee?: TeamActor | null; expectedVersion: string },
	): Promise<TeamDiscussion> {
		const state = await this.get(ref);
		if (!state) throw new TeamStateError(404, "Proposal history not found");
		if (state.version !== input.expectedVersion)
			throw new TeamStateError(409, "Discussion changed; reload before submitting");
		if (input.text !== undefined) {
			state.comments.push({ id: randomUUID(), author: actor, at: new Date().toISOString(), text: input.text });
			for (const recipient of [state.current.proposedBy, state.assignedTo].filter((value): value is TeamActor =>
				Boolean(value),
			)) {
				await this.notify(recipient, actor, ref, state.current.title, "提案收到新评论。");
			}
		}
		if (input.assignee !== undefined) {
			state.assignedTo = input.assignee ?? undefined;
			if (input.assignee)
				await this.notify(input.assignee, actor, ref, state.current.title, "此提案已指派给你审核。");
		}
		return this.save(state);
	}
	private async notify(
		recipient: TeamActor,
		actor: TeamActor,
		ref: TeamContentRef,
		title: string,
		message: string,
	): Promise<void> {
		if (sameActor(recipient, actor) || recipient.id.startsWith("legacy:")) return;
		const value: TeamNotification = {
			...ref,
			id: randomUUID(),
			targetId: ref.id,
			title,
			message,
			at: new Date().toISOString(),
		};
		await writeJsonAtomic(
			join(this.root, "collaboration", "notifications", stableFingerprint(recipient.id), `${value.id}.json`),
			value,
		);
	}
	async notifications(actor: TeamActor): Promise<TeamNotification[]> {
		const directory = join(this.root, "collaboration", "notifications", stableFingerprint(actor.id));
		const entries: TeamNotification[] = [];
		for (const name of await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [] as string[];
			throw error;
		})) {
			if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
			const entry = await readJson<TeamNotification>(join(directory, name));
			if (entry) entries.push(entry);
		}
		return entries.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
	}
	async readNotifications(actor: TeamActor, ids: string[]): Promise<void> {
		const entries = await this.notifications(actor);
		const targets = ids.map((id) => entries.find((entry) => entry.id === id));
		if (targets.some((entry) => !entry)) throw new TeamStateError(404, "Notification not found");
		for (const entry of targets)
			if (entry && !entry.readAt) {
				await writeJsonAtomic(
					join(this.root, "collaboration", "notifications", stableFingerprint(actor.id), `${entry.id}.json`),
					{ ...entry, readAt: new Date().toISOString() },
				);
			}
	}
	async topics(): Promise<TeamTopic[]> {
		const directory = join(this.root, "topics");
		const entries: TeamTopic[] = [];
		for (const name of await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [] as string[];
			throw error;
		}))
			if (name.endsWith(".json")) {
				const value = await readJson<TeamTopic>(join(directory, name));
				if (value) entries.push(value);
			}
		return entries.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	}
	async changeTopic(input: TeamTopicChange, actor: TeamActor): Promise<TeamTopic | { deleted: string }> {
		const path = join(this.root, "topics", `${safeSegment(input.id, "topic id")}.json`);
		const existing = await readJson<TeamTopic>(path);
		if (existing ? existing.version !== input.expectedVersion : input.expectedVersion !== undefined) {
			throw new TeamStateError(409, "Topic changed; reload before submitting");
		}
		if (input.delete) {
			if (!existing) throw new TeamStateError(404, "Topic not found");
			await removeTeamFile(path);
			return { deleted: input.id };
		}
		const value: TeamTopic = {
			id: input.id,
			title: input.title!,
			description: input.description ?? "",
			entries: input.entries ?? [],
			updatedAt: new Date().toISOString(),
			updatedBy: actor,
			version: "",
		};
		value.version = stableFingerprint(value);
		await writeJsonAtomic(path, value);
		return value;
	}
}
