import type {
	CorpusManifest,
	CorpusSearchHit,
	PaperRecord,
	PaperVersion,
	ScreeningStatus,
} from "../protocol/literature-types.ts";
import type { SharedReviewStatus } from "../protocol/team-corpus-types.ts";

export interface TeamLiteratureRepository {
	initialize(): Promise<void>;
	listPapers(): Promise<PaperRecord[]>;
	getPaper(id: string): Promise<PaperRecord | undefined>;
	searchPapers(options: {
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
		readOnly?: boolean;
	}): Promise<CorpusSearchHit[]>;
	proposePapers(records: PaperRecord[], contributor: string): Promise<number>;
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
