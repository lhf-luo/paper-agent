import { TeamStateError } from "../domain/team-state-error.ts";
import type { ArtifactManifest, DerivedRecord, PaperRecord } from "../protocol/literature-types.ts";
import type {
	TeamActor,
	TeamCollaborationChange,
	TeamContentQuery,
	TeamContentRef,
	TeamContentSummary,
	TeamDiscussion,
	TeamListPage,
	TeamPageEntry,
	TeamReviewResource,
	TeamReviewSnapshot,
	TeamSubmission,
	TeamTopicChange,
} from "../protocol/team-corpus-types.ts";
import { sameActor, snapshotReview, submissionFor } from "../infrastructure/team-collaboration-repository.ts";
import { stableFingerprint } from "../infrastructure/team-knowledge-serialization.ts";
import type { TeamKnowledgeStore } from "../infrastructure/team-knowledge-store.ts";

export interface TeamContentViewer {
	actor: TeamActor;
	canRead: boolean;
	canContribute: boolean;
	canReview: boolean;
}

export function pageOf<T>(entries: T[], cursor?: string, limit = 50): TeamListPage<T> {
	const offset = cursor === undefined ? 0 : Number(cursor);
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
		throw new TeamStateError(400, "Invalid cursor or limit (1–200)");
	}
	return {
		entries: entries.slice(offset, offset + limit),
		total: entries.length,
		nextCursor: offset + limit < entries.length ? String(offset + limit) : undefined,
	};
}

function summary(snapshot: TeamReviewSnapshot): TeamContentSummary {
	let text = "";
	let paperIds: string[] = [];
	let metadata: Pick<TeamContentSummary, "page" | "derived" | "artifact"> = {};
	if (snapshot.resource === "papers") {
		const { record } = snapshot.content as { record: PaperRecord };
		text = record.abstract ?? "";
		paperIds = [record.id];
	} else if (snapshot.resource === "pages") {
		const { snapshot: page } = snapshot.content as TeamPageEntry;
		text = page.markdown;
		paperIds = page.paperIds;
		const { markdown: _body, ...source } = page;
		metadata = { page: source };
	} else if (snapshot.resource === "derived") {
		const { record } = snapshot.content as { record: DerivedRecord };
		text = JSON.stringify(record.result);
		paperIds = [record.paperId];
		metadata = {
			derived: {
				key: record.key,
				paperId: record.paperId,
				operation: record.operation,
				createdAt: record.createdAt,
			},
		};
	} else {
		const entry = snapshot.content as { paperId: string; manifest: ArtifactManifest };
		text = entry.manifest.candidates.map((candidate) => candidate.url).join(" ");
		paperIds = [entry.paperId];
		metadata = {
			artifact: {
				pdfSha256: entry.manifest.pdfSha256,
				candidateCount: entry.manifest.candidates.length,
				acquisitionCount: entry.manifest.acquisitions.length,
			},
		};
	}
	return {
		...metadata,
		resource: snapshot.resource,
		id: snapshot.id,
		title: snapshot.title,
		version: snapshot.version,
		review: snapshotReview(snapshot),
		excerpt: text.replace(/\s+/g, " ").slice(0, 240),
		paperIds,
	};
}

export class TeamContentService {
	readonly store: TeamKnowledgeStore;
	constructor(store: TeamKnowledgeStore) {
		this.store = store;
	}

	private async raw(ref: TeamContentRef, pending: boolean): Promise<TeamReviewSnapshot | undefined> {
		if (pending) {
			try {
				return (await this.store.reviewSnapshots(ref.resource, [ref.id]))[0];
			} catch (error) {
				if (error instanceof TeamStateError && error.status === 404) return undefined;
				throw error;
			}
		}
		let content: unknown;
		let title = ref.id;
		if (ref.resource === "papers") {
			const record = await this.store.literature.getPaper(ref.id);
			if (record?.curation?.teamReview?.status !== "team-approved") return undefined;
			const versions = (await this.store.literature.listPaperVersions(ref.id))
				.filter((version) => !version.teamReview || version.teamReview.status === "team-approved")
				.map(({ blobPath: _path, ...version }) => version);
			content = { record, versions };
			title = record.title;
		} else {
			const repository =
				ref.resource === "pages"
					? this.store.pages
					: ref.resource === "derived"
						? this.store.derived
						: this.store.artifacts;
			const entry = (await repository.get(ref.id))?.published;
			if (!entry) return undefined;
			content = entry;
			if ("snapshot" in entry) title = entry.snapshot.title;
			else if ("record" in entry) title = entry.record.operation;
		}
		return { ...ref, title, content, version: stableFingerprint({ ...ref, content, approvedContent: undefined }) };
	}
	private async refs(resource?: TeamReviewResource): Promise<TeamContentRef[]> {
		const result: TeamContentRef[] = [];
		if (!resource || resource === "papers")
			for (const paper of await this.store.literature.listPapers())
				result.push({ resource: "papers", id: paper.id });
		if (!resource || resource === "pages")
			for (const id of await this.store.pages.keys()) result.push({ resource: "pages", id });
		if (!resource || resource === "derived")
			for (const id of await this.store.derived.keys()) result.push({ resource: "derived", id });
		if (!resource || resource === "artifacts")
			for (const id of await this.store.artifacts.keys()) result.push({ resource: "artifacts", id });
		return result;
	}
	private visible(snapshot: TeamReviewSnapshot, viewer: TeamContentViewer, pending: boolean): boolean {
		if (viewer.canReview) return true;
		if (!pending) return viewer.canRead && snapshotReview(snapshot).status === "team-approved";
		return viewer.canContribute && sameActor(submissionFor(snapshot).proposedBy, viewer.actor);
	}
	async read(
		ref: TeamContentRef,
		viewer: TeamContentViewer,
		pending = false,
		version?: string,
	): Promise<TeamReviewSnapshot> {
		return this.store.withWriteOperation(async () => {
			const value = version ? await this.store.collaboration.snapshot(ref, version) : await this.raw(ref, pending);
			if (!value || !this.visible(value, viewer, pending || Boolean(version)))
				throw new TeamStateError(404, "Team content not found");
			return value;
		}, false);
	}
	async search(query: TeamContentQuery, viewer: TeamContentViewer): Promise<TeamListPage<TeamContentSummary>> {
		if (!viewer.canRead && !viewer.canReview && !(query.pending && viewer.canContribute))
			throw new TeamStateError(403, "reader role required");
		return this.store.withWriteOperation(async () => {
			const topics = query.topicId ? await this.store.collaboration.topics() : [];
			const topic = topics.find((entry) => entry.id === query.topicId);
			if (query.topicId && !topic) throw new TeamStateError(404, "Topic not found");
			const terms = (query.query ?? "").normalize("NFKC").toLocaleLowerCase().split(/\s+/).filter(Boolean);
			const entries: TeamContentSummary[] = [];
			for (const ref of await this.refs(query.resource)) {
				if (topic && !topic.entries.some((entry) => entry.resource === ref.resource && entry.id === ref.id))
					continue;
				const snapshot = await this.raw(ref, Boolean(query.pending));
				if (!snapshot || !this.visible(snapshot, viewer, Boolean(query.pending))) continue;
				if (query.pending && snapshotReview(snapshot).status !== "team-proposed") continue;
				const searchable = `${snapshot.title}\n${JSON.stringify(snapshot.content)}`
					.normalize("NFKC")
					.toLocaleLowerCase();
				if (!terms.every((term) => searchable.includes(term))) continue;
				entries.push(summary(snapshot));
			}
			entries.sort(
				(a, b) =>
					a.title.localeCompare(b.title) || a.resource.localeCompare(b.resource) || a.id.localeCompare(b.id),
			);
			return pageOf(entries, query.cursor, query.limit);
		}, false);
	}
	private projected(snapshot: TeamReviewSnapshot): TeamDiscussion {
		const result: TeamDiscussion = {
			resource: snapshot.resource,
			id: snapshot.id,
			current: submissionFor(snapshot),
			history: [],
			comments: [],
			version: "",
		};
		result.version = stableFingerprint({ ...result, version: undefined });
		return result;
	}
	async proposals(
		viewer: TeamContentViewer,
		options: { mine?: boolean; cursor?: string; limit?: number; status?: string } = {},
	): Promise<TeamListPage<TeamSubmission>> {
		if (options.mine ? !viewer.canContribute : !viewer.canReview)
			throw new TeamStateError(403, "Proposal access denied");
		return this.store.withWriteOperation(async () => {
			const discussions = await this.store.collaboration.list();
			for (const ref of await this.refs()) {
				if (discussions.some((entry) => entry.resource === ref.resource && entry.id === ref.id)) continue;
				const snapshot = await this.raw(ref, true);
				if (snapshot) discussions.push(this.projected(snapshot));
			}
			const entries = discussions
				.flatMap((discussion) => [discussion.current, ...discussion.history])
				.filter(
					(entry) =>
						(!options.mine || sameActor(entry.proposedBy, viewer.actor)) &&
						(!options.status || entry.status === options.status),
				)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.version.localeCompare(b.version));
			return pageOf(entries, options.cursor, options.limit);
		}, false);
	}
	async discussion(ref: TeamContentRef, viewer: TeamContentViewer): Promise<TeamDiscussion> {
		return this.store.withWriteOperation(async () => {
			const snapshot = await this.raw(ref, true);
			const value = (await this.store.collaboration.get(ref)) ?? (snapshot ? this.projected(snapshot) : undefined);
			if (
				!value ||
				(!viewer.canReview && !(viewer.canContribute && sameActor(value.current.proposedBy, viewer.actor)))
			)
				throw new TeamStateError(404, "Proposal discussion not found");
			return value;
		}, false);
	}
	async change(
		input: TeamCollaborationChange,
		viewer: TeamContentViewer,
		assignee?: TeamActor | null,
	): Promise<unknown> {
		if (input.action === "request-changes") {
			if (!viewer.canReview) throw new TeamStateError(403, "reviewer role required");
			const snapshot = await this.read(input, viewer, true);
			if (snapshotReview(snapshot).status !== "team-proposed")
				throw new TeamStateError(409, "Only pending proposals can be returned");
			const versions = { [input.id]: input.expectedVersion };
			const ids = [input.id];
			const args = [ids, "team-rejected", viewer.actor, input.text, versions, "changes-requested"] as const;
			if (input.resource === "papers") return this.store.reviewPapers(...args);
			if (input.resource === "pages") return this.store.reviewPages(...args);
			if (input.resource === "derived") return this.store.reviewDerived(...args);
			return this.store.reviewArtifact(...args);
		}
		if (input.action === "withdraw" && input.resource === "papers") {
			if (!viewer.canContribute) throw new TeamStateError(403, "contributor role required");
			const snapshot = await this.read(input, viewer, true);
			if (!sameActor(submissionFor(snapshot).proposedBy, viewer.actor))
				throw new TeamStateError(403, "Only the proposer can withdraw");
			return {
				withdrawn: await this.store.withdrawPapers([input.id], viewer.actor, { [input.id]: input.expectedVersion }),
			};
		}
		return this.store.withWriteOperation(async () => {
			const snapshot = await this.raw(input, true);
			let discussion = await this.store.collaboration.get(input);
			if (!discussion && snapshot) {
				await this.store.collaboration.record(snapshot, viewer.actor);
				discussion = await this.store.collaboration.get(input);
			}
			if (!discussion) throw new TeamStateError(404, "Proposal not found");
			const owner = sameActor(discussion.current.proposedBy, viewer.actor);
			if (input.action === "withdraw") {
				if (!viewer.canContribute || !owner) throw new TeamStateError(403, "Only the proposer can withdraw");
				await this.store.assertReviewVersions(input.resource, [input.id], { [input.id]: input.expectedVersion });
				const repository =
					input.resource === "pages"
						? this.store.pages
						: input.resource === "derived"
							? this.store.derived
							: this.store.artifacts;
				await repository.withdraw(input.id, viewer.actor);
				await this.store.collaboration.record(snapshot!, viewer.actor, "withdrawn");
				await this.store.appendAudit(viewer.actor, `${input.resource}.withdraw`, input.id);
				return { withdrawn: [input.id] };
			}
			if (input.action === "assign" ? !viewer.canReview : !viewer.canReview && !(viewer.canContribute && owner))
				throw new TeamStateError(403, "Proposal feedback access denied");
			const result = await this.store.collaboration.feedback(input, viewer.actor, {
				text: input.action === "comment" ? input.text : undefined,
				assignee: input.action === "assign" ? assignee : undefined,
				expectedVersion: input.expectedVersion,
			});
			await this.store.appendAudit(viewer.actor, `proposal.${input.action}`, input.id, {
				resource: input.resource,
				assigneeId: assignee?.id,
			});
			return result;
		});
	}
	async topics(viewer: TeamContentViewer, cursor?: string, limit?: number) {
		if (!viewer.canRead && !viewer.canReview) throw new TeamStateError(403, "reader role required");
		return this.store.withWriteOperation(async () => {
			const entries = await this.store.collaboration.topics();
			for (const topic of entries) {
				const visible: TeamContentRef[] = [];
				for (const ref of topic.entries) if (await this.raw(ref, false)) visible.push(ref);
				topic.entries = visible;
			}
			return pageOf(entries, cursor, limit);
		}, false);
	}
	async changeTopic(input: TeamTopicChange, viewer: TeamContentViewer) {
		if (!viewer.canReview) throw new TeamStateError(403, "reviewer role required");
		return this.store.withWriteOperation(async () => {
			for (const ref of input.entries ?? [])
				if (!(await this.raw(ref, false)))
					throw new TeamStateError(404, "Topics can only contain published content");
			const result = await this.store.collaboration.changeTopic(input, viewer.actor);
			await this.store.appendAudit(viewer.actor, input.delete ? "topic.delete" : "topic.save", input.id);
			return result;
		});
	}
}
