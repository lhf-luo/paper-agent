import type {
	CorpusManifest,
	CorpusSearchHit,
	PaperRecord,
	PaperVersion,
	ScreeningStatus,
} from "../protocol/literature-types.ts";
import type { SharedReviewStatus } from "../protocol/team-corpus-types.ts";

/** A proposal reused an existing team paper id for what its identifiers say is a different paper. */
export class TeamPaperConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TeamPaperConflictError";
	}
}

/** Display name plus, when known, the stable member id of the person acting on a record. */
export interface TeamContributor {
	name: string;
	id?: string;
}

/**
 * Whether a pending review entry was proposed by the given identity. The stable member id wins when both
 * sides carry one; the display name is only a fallback for records written before ids were recorded, since
 * administrators can rename members.
 */
export function proposedByIdentity(
	review: { proposedBy?: string; proposedById?: string } | undefined,
	identity: TeamContributor,
): boolean {
	if (!review) return false;
	if (review.proposedById && identity.id) return review.proposedById === identity.id;
	return review.proposedBy === identity.name;
}

export interface TeamLiteratureRepository {
	invalidate?(): void;
	initialize(): Promise<void>;
	listPapers(): Promise<PaperRecord[]>;
	/** Records awaiting review: freshly proposed papers plus pending revisions of approved ones. */
	listPendingPapers(): Promise<PaperRecord[]>;
	getPaper(id: string): Promise<PaperRecord | undefined>;
	getReviewablePaper(id: string): Promise<PaperRecord | undefined>;
	searchPapers(options: {
		query?: string;
		yearFrom?: number;
		yearTo?: number;
		authors?: string[];
		venues?: string[];
		tags?: string[];
		identifiers?: string[];
		screeningStatuses?: ScreeningStatus[];
		reviewStatuses?: SharedReviewStatus[];
		types?: string[];
		openAccess?: boolean;
		offset?: number;
		limit?: number;
		readOnly?: boolean;
	}): Promise<CorpusSearchHit[]>;
	listPaperVersions(paperId: string): Promise<PaperVersion[]>;
	proposePapers(records: PaperRecord[], contributor: string, contributorId?: string): Promise<number>;
	withdrawPapers(paperIds: string[], contributor: string, contributorId?: string): Promise<string[]>;
	reviewTeamPaper(
		id: string,
		decision: Exclude<SharedReviewStatus, "team-proposed">,
		reviewer: string,
		reason?: string,
	): Promise<PaperRecord>;
	putBlob(data: Uint8Array): Promise<{ sha256: string; path: string; existed: boolean }>;
	savePaperVersion(version: PaperVersion): Promise<void>;
	audit(options?: { readOnly?: boolean }): Promise<{
		manifest: CorpusManifest;
		recordsMissingPrimaryLink: string[];
		recordsMissingProvenance: string[];
		teamRecordsPendingReview: string[];
	}>;
}
