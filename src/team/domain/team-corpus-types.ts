import type { ArtifactManifest, DerivedRecord } from "../../literature/domain/literature-types.ts";

export type SharedReviewStatus = "team-proposed" | "team-approved" | "team-rejected";

export interface SharedReview {
	status: SharedReviewStatus;
	proposedBy: string;
	proposedById?: string;
	proposedAt: string;
	reviewedBy?: string;
	reviewedById?: string;
	reviewedAt?: string;
	reason?: string;
	withdrawnAt?: string;
	/** A proposed replacement; the published copy remains readable until approval. */
	revision?: boolean;
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

export type TeamPageSourceKind = "note" | "wiki";

export interface TeamPageSourcesInput {
	sources: Array<{ kind: TeamPageSourceKind; id: string }>;
	personalNamespace?: string;
}

export interface TeamPageSnapshot {
	/** Server-assigned origin key. Proposals may use `${kind}.${sourceId}` as a temporary key. */
	key: string;
	sourceId: string;
	sourceNamespace?: string;
	/** Always assigned by the authenticated server, never trusted from proposal input. */
	sourceIdentityId?: string;
	kind: TeamPageSourceKind;
	title: string;
	markdown: string;
	contentHash: string;
	revision: number;
	paperIds: string[];
	createdAt: string;
	createdBy?: string;
}

export interface TeamPageEntry {
	snapshot: TeamPageSnapshot;
	review: SharedReview;
}

export interface TeamAuditEvent {
	id: string;
	at: string;
	actorId?: string;
	actor: string;
	action: string;
	target?: string;
	details?: Record<string, unknown>;
}

export interface TeamActor {
	id: string;
	name: string;
}

export type TeamReviewResource = "papers" | "derived" | "artifacts" | "pages";
export type TeamReviewVersions = Record<string, string>;

/** Exact server content displayed for a review; version includes its current decision and attachments. */
export interface TeamReviewSnapshot {
	resource: TeamReviewResource;
	id: string;
	title: string;
	version: string;
	content: unknown;
	approvedContent?: unknown;
}

export interface TeamContentRef {
	resource: TeamReviewResource;
	id: string;
}

export interface TeamContentSummary extends TeamContentRef {
	title: string;
	version: string;
	review: SharedReview;
	excerpt: string;
	paperIds: string[];
	page?: Omit<TeamPageSnapshot, "markdown">;
	derived?: Pick<DerivedRecord, "key" | "paperId" | "operation" | "createdAt">;
	artifact?: { pdfSha256: string; candidateCount: number; acquisitionCount: number };
}

export interface TeamListPage<T> {
	entries: T[];
	nextCursor?: string;
	total: number;
}

export interface TeamContentQuery {
	resource?: TeamReviewResource;
	query?: string;
	pending?: boolean;
	topicId?: string;
	cursor?: string;
	limit?: number;
}

export type TeamProposalStatus = "pending" | "approved" | "rejected" | "changes-requested" | "withdrawn" | "superseded";

export interface TeamSubmission extends TeamContentRef {
	title: string;
	version: string;
	proposedBy: TeamActor;
	proposedAt: string;
	status: TeamProposalStatus;
	revision: boolean;
	updatedAt: string;
	reviewedBy?: TeamActor;
	reason?: string;
}

export interface TeamComment {
	id: string;
	author: TeamActor;
	at: string;
	text: string;
}

export interface TeamDiscussion extends TeamContentRef {
	current: TeamSubmission;
	history: TeamSubmission[];
	assignedTo?: TeamActor;
	comments: TeamComment[];
	/** Includes feedback changes, independently of the reviewed content version. */
	version: string;
}

export interface TeamNotification extends TeamContentRef {
	id: string;
	targetId: string;
	title: string;
	message: string;
	at: string;
	readAt?: string;
}

export interface TeamCollaborationChange extends TeamContentRef {
	action: "comment" | "assign" | "request-changes" | "withdraw";
	text?: string;
	assigneeId?: string | null;
	expectedVersion: string;
}

export interface TeamTopic {
	id: string;
	title: string;
	description: string;
	entries: TeamContentRef[];
	updatedAt: string;
	updatedBy: TeamActor;
	version: string;
}

export interface TeamTopicChange {
	id: string;
	title?: string;
	description?: string;
	entries?: TeamContentRef[];
	delete?: boolean;
	expectedVersion?: string;
}
