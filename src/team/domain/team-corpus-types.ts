import type { ArtifactManifest, DerivedRecord } from "../../literature/domain/literature-types.ts";

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
	actorId?: string;
	actor: string;
	action: string;
	target?: string;
	details?: Record<string, unknown>;
}
