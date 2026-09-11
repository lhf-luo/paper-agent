import type { CorpusExportFormat } from "../../literature/application/corpus-operations.ts";
import type { DoiEnrichmentResult, DoiProviderLookup } from "../../literature/application/literature-doi-enrichment.ts";
import type {
	LiteraturePdfDownloadRequest,
	PreparedLiteraturePdfDownload,
} from "../../literature/application/literature-download.ts";
import type {
	ArtifactManifest,
	LiteratureProvider,
	PaperRecord,
	ScreeningStatus,
	SearchFilters,
} from "../../literature/domain/literature-types.ts";
import type { PdfBox } from "../../pdf/domain/pdf-types.ts";
import type { OperationExecutionPermit } from "../../shared/application/operation-consent.ts";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";

export type { AuthorizedMineruJob } from "../../extensions/mineru/application/mineru-job.ts";
export type {
	MineruGenerationRequest,
	MineruPackageManifest,
	MineruStatus,
} from "../../extensions/mineru/domain/mineru-types.ts";
export type { AuthorizedPdfTranslationJob } from "../../extensions/pdf-translation/application/pdf-translation-job.ts";
export type {
	PdfTranslationRequest,
	PdfTranslationResult,
} from "../../extensions/pdf-translation/domain/pdf-translation-types.ts";

export interface PaperAgentApplicationConfig {
	projectRoot: string;
	dataRoot?: string;
	corpusRoot?: string;
	defaultNamespace?: string;
	executor?: CommandExecutor;
	jobConcurrency?: number;
	doiProviderLookup?: DoiProviderLookup;
}

export interface LiteratureSearchJobInput {
	query: string;
	queryExpansions?: string[];
	providers?: LiteratureProvider[];
	filters?: SearchFilters;
	pagesPerProvider?: number;
	maxResultsPerProvider?: number;
	namespace?: string;
	reuseCorpus?: boolean;
	checkpointId?: string;
}

export interface PdfDownloadPreparationInput {
	paperIds?: string[];
	maxFiles?: number;
	maxMegabytesPerFile?: number;
	concurrency?: number;
	namespace?: string;
}

export interface ArtifactDiscoveryInput {
	pdfPath: string;
	sourceDirectory?: string;
	paperId?: string;
	namespace?: string;
	additionalCandidateUrls?: string[];
}

export interface ArtifactAcquisitionPreparationInput extends ArtifactDiscoveryInput {
	candidateIds?: string[];
	maxArtifacts?: number;
	maxMegabytesPerArtifact?: number;
}

export interface AuthorizedPdfDownloadJob {
	executionPermit: OperationExecutionPermit;
	request: LiteraturePdfDownloadRequest;
	prepared: PreparedLiteraturePdfDownload;
	namespace: string;
}

export interface AuthorizedArtifactJob {
	executionPermit: OperationExecutionPermit;
	manifest: ArtifactManifest;
	paperId?: string;
	namespace: string;
	candidateIds?: string[];
	maxArtifacts: number;
	maxBytesPerArtifact: number;
}

export interface CorpusImportInput {
	searchJobId?: string;
	searchRunId?: string;
	sidebarResultUrl?: string;
	paperIds?: string[];
	namespace?: string;
	/** 保存后归入的分类(集合) id; 不传则保持未分类。 */
	collectionId?: string;
}

export interface AuthorizedCorpusImportJob extends CorpusImportInput {
	executionPermit: OperationExecutionPermit;
	records: PaperRecord[];
	doiEnrichment: Omit<DoiEnrichmentResult, "records">;
}

export interface TeamPaperProposalInput {
	paperIds: string[];
	personalNamespace?: string;
}

export interface TeamPullInput {
	paperIds: string[];
	personalNamespace?: string;
	includePdf?: boolean;
}

export type { TeamPullResult } from "../../team/application/team-pull.ts";

export interface TeamDerivedProposalInput {
	keys: string[];
	personalNamespace?: string;
}

export interface TeamWithdrawInput {
	paperIds: string[];
}

export interface TeamReviewInput {
	resource: "papers" | "derived" | "artifacts";
	ids: string[];
	decision: "team-approved" | "team-rejected";
	reason?: string;
}


export interface TeamArtifactProposalInput {
	artifactJobId: string;
	paperId: string;
	personalNamespace?: string;
}

export interface TeamBlobUploadInput {
	paperId: string;
	sha256: string;
	personalNamespace?: string;
}

export interface TeamRestoreDrillInput {
	backupPath: string;
}

export interface PdfAssetCorrectionInput {
	analysisJobId: string;
	assetId: string;
	correctedRegion: PdfBox;
	note?: string;
	author?: string;
}

export interface PersonalCorpusAnnotationInput {
	paperIds: string[];
	namespace?: string;
	author?: string;
	tags?: string[];
	note?: string;
	screeningStatus?: ScreeningStatus;
	screeningReason?: string;
}

export interface PersonalPaperRemovalInput {
	paperId?: string;
	paperIds?: string[];
	namespace?: string;
	collectionId?: string;
	author?: string;
}

export type PersonalCorpusExportFormat = CorpusExportFormat;

export interface PersonalCorpusExportInput {
	namespace?: string;
	paperIds?: string[];
	format: PersonalCorpusExportFormat;
	filename?: string;
}
