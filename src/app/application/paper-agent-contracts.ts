import type { ModelApiKind } from "../../config/domain/config-types.ts";
import type { CorpusExportFormat } from "../../literature/application/corpus-operations.ts";
import type { DoiEnrichmentResult, DoiProviderLookup } from "../../literature/application/literature-doi-enrichment.ts";
import type {
	LiteraturePdfDownloadRequest,
	PreparedLiteraturePdfDownload,
} from "../../literature/application/literature-download.ts";
import type { MetadataProviderSearcher } from "../../literature/application/literature-metadata-refresh.ts";
import type {
	ArtifactManifest,
	LiteratureProvider,
	PaperRecord,
	ScreeningStatus,
	SearchFilters,
} from "../../literature/domain/literature-types.ts";
import type { PaperDetailFieldInput } from "../../literature/domain/paper-detail-fields.ts";
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

	executor?: CommandExecutor;
	jobConcurrency?: number;
	doiProviderLookup?: DoiProviderLookup;
	metadataProviderSearcher?: MetadataProviderSearcher;
}

export interface LiteratureSearchJobInput {
	query: string;
	queryExpansions?: string[];
	providers?: LiteratureProvider[];
	filters?: SearchFilters;
	pagesPerProvider?: number;
	maxResultsPerProvider?: number;

	reuseCorpus?: boolean;
	checkpointId?: string;
}

export interface PdfDownloadPreparationInput {
	paperIds?: string[];
	publicationVersionId?: string;
	maxFiles?: number;
	maxMegabytesPerFile?: number;
	concurrency?: number;
}

export interface ArtifactDiscoveryInput {
	pdfPath: string;
	sourceDirectory?: string;
	paperId?: string;

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
}

export interface AuthorizedArtifactJob {
	executionPermit: OperationExecutionPermit;
	manifest: ArtifactManifest;
	paperId?: string;

	candidateIds?: string[];
	maxArtifacts: number;
	maxBytesPerArtifact: number;
}

export interface CorpusImportInput {
	searchJobId?: string;
	searchRunId?: string;
	newsBatchId?: string;
	sidebarResultUrl?: string;
	paperIds?: string[];

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

	/** Existing shared categories to request; a reviewer applies them when approving the papers. */
	topicIds?: string[];
}

export interface TeamPullInput {
	paperIds: string[];

	includePdf?: boolean;
}

export type { TeamPullResult } from "../../team/application/team-pull.ts";

export interface TeamDerivedProposalInput {
	keys: string[];
}

export type TeamPagesProposalInput = import("../../team/domain/team-corpus-types.ts").TeamPageSourcesInput;

export interface TeamWithdrawInput {
	paperIds: string[];
}

export interface TeamReviewInput {
	resource: "papers" | "derived" | "artifacts" | "pages";
	ids: string[];
	decision: "team-approved" | "team-rejected";
	reason?: string;
	expectedVersions?: Record<string, string>;
}

export interface TeamArtifactProposalInput {
	artifactJobId?: string;
	manifestSha256?: string;
	paperId: string;
}

export interface TeamBlobUploadInput {
	paperId: string;
	sha256: string;
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

	author?: string;
	tags?: string[];
	note?: string;
	screeningStatus?: ScreeningStatus;
	screeningReason?: string;
}

export interface PersonalMetadataEnrichmentInput {
	paperId: string;

	author?: string;
}

export interface PersonalPaperDetailFieldsInput {
	paperId: string;

	expectedRevision: number;
	fields: PaperDetailFieldInput[];
}

export interface PersonalPaperRemovalInput {
	mode: "remove-from-collection" | "permanent-delete";
	paperIds: string[];

	collectionId?: string;
	author?: string;
}

export interface PersonalPdfVersionRemovalInput {
	paperId: string;
	sha256: string;

	author?: string;
}

/** 批量清洗标题杂质；省略 paperIds 时处理整个命名空间。 */
export interface PersonalTitleRepairInput {
	paperIds?: string[];

	author?: string;
}

export type PersonalCorpusExportFormat = CorpusExportFormat;

export interface PersonalCorpusExportInput {
	paperIds?: string[];
	format: PersonalCorpusExportFormat;
	filename?: string;
}

/**
 * 设置页"添加供应商"的一次性发现请求。它只读取远端 `/models` 列表，不写入任何
 * 配置：密钥只存在于这一次请求中，只有用户确认保存设置后才会落盘。
 */
export interface ModelDiscoveryRequestInput {
	providerId?: string;
	baseUrl: string;
	api: ModelApiKind;
	apiKey: string;
}

export interface DiscoveredModelView {
	id: string;
	name: string;
}
