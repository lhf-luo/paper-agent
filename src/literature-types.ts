export type LiteratureProvider =
	| "arxiv"
	| "openalex"
	| "crossref"
	| "semanticscholar"
	| "dblp"
	| "pubmed"
	| "core"
	| "opencitations"
	| "unpaywall";
export type ProvenanceProvider = LiteratureProvider | "local-pdf" | "bibtex-import" | "json-import";
export type CorpusScope = "personal" | "team";
export type PersistenceMode = "once" | "persistent";
export type ScreeningStatus = "unreviewed" | "include" | "exclude" | "maybe";
export type TeamReviewStatus = "personal" | "team-proposed" | "team-approved" | "team-rejected";

export interface SearchFilters {
	yearFrom?: number;
	yearTo?: number;
	venues?: string[];
	authors?: string[];
	openAccess?: boolean;
	types?: string[];
}

export interface PaperIdentifiers {
	doi?: string;
	arxivId?: string;
	openAlexId?: string;
	semanticScholarId?: string;
	dblpKey?: string;
	pmid?: string;
	coreId?: string;
	openCitationsId?: string;
}

export interface PaperLink {
	url: string;
	kind: "landing" | "pdf" | "doi" | "artifact" | "other";
	openAccess?: boolean;
}

export interface PaperProvenance {
	provider: ProvenanceProvider;
	query: string;
	retrievedAt: string;
	providerRecordId?: string;
	rawUrl?: string;
}

export interface PaperUserNote {
	id: string;
	text: string;
	author: string;
	createdAt: string;
}

export interface PaperCuration {
	tags: string[];
	userNotes: PaperUserNote[];
	screening?: {
		status: ScreeningStatus;
		reason?: string;
		updatedBy: string;
		updatedAt: string;
	};
	teamReview?: {
		status: TeamReviewStatus;
		proposedBy?: string;
		proposedAt?: string;
		reviewedBy?: string;
		reviewedAt?: string;
		reason?: string;
	};
}

export interface PaperRecord {
	id: string;
	title: string;
	abstract?: string;
	authors: string[];
	year?: number;
	venue?: string;
	publicationType?: string;
	identifiers: PaperIdentifiers;
	links: PaperLink[];
	materialHashes?: string[];
	citationCount?: number;
	referencedWorks?: string[];
	citedByApiUrl?: string;
	provenance: PaperProvenance[];
	mergedFrom: string[];
	curation?: PaperCuration;
}

export interface PossibleDuplicate {
	leftId: string;
	rightId: string;
	titleSimilarity: number;
	reason: "similar-title";
}

export interface CorpusSearchHit {
	record: PaperRecord;
	score: number;
	matchedFields: string[];
}

export interface PaperVersion {
	paperId: string;
	sourceUrl: string;
	finalUrl: string;
	retrievedAt: string;
	sha256: string;
	bytes: number;
	blobPath: string;
	contentType: string;
}

export interface ProviderPage {
	provider: LiteratureProvider;
	query: string;
	records: PaperRecord[];
	nextCursor?: string;
	total?: number;
	requestUrl: string;
}

export interface ProviderFailure {
	provider: LiteratureProvider;
	query: string;
	message: string;
	retryable: boolean;
	statusCode?: number;
	rateLimited?: boolean;
	retryAfter?: string;
}

export interface ProviderHealthSnapshot {
	status: "healthy" | "partial" | "rate-limited" | "failed" | "not-run";
	recordCount: number;
	failureCount: number;
	checkedAt: string;
	message?: string;
	retryAfter?: string;
}

export interface SearchRun {
	id: string;
	startedAt: string;
	completedAt: string;
	queries: string[];
	filters: SearchFilters;
	providers: LiteratureProvider[];
	pagesPerProvider: number;
	maxResultsPerProvider: number;
	results: PaperRecord[];
	failures: ProviderFailure[];
	sourceCounts: Partial<Record<LiteratureProvider, number>>;
	deduplicatedCount: number;
	corpusHitCount?: number;
	possibleDuplicates?: PossibleDuplicate[];
	providerHealth?: Partial<Record<LiteratureProvider, ProviderHealthSnapshot>>;
	resumedFromCheckpoint?: boolean;
	scope: CorpusScope;
	mode: PersistenceMode;
	namespace: string;
}

export interface ArtifactCandidate {
	id: string;
	url: string;
	kind: "repository" | "dataset" | "supplement" | "project" | "unknown";
	host: string;
	parentCandidateId?: string;
	sources: Array<{
		method: "pdfinfo-url" | "pdftotext" | "doi-derived";
		page?: number;
		context?: string;
		url?: string;
	}>;
	confidence: "high" | "medium" | "low";
}

export interface ArtifactSourceFile {
	name: string;
	url: string;
	bytes?: number;
	checksum?: string;
}

export interface ArtifactSnapshot {
	candidateId: string;
	sourceUrl: string;
	status: "downloaded" | "cloned" | "skipped" | "failed";
	localPath?: string;
	retrievedAt: string;
	finalUrl?: string;
	sha256?: string;
	bytes?: number;
	contentType?: string;
	detectedContentType?: string;
	contentDisposition?: string;
	contentValidation?: "validated" | "unverified";
	commit?: string;
	remote?: string;
	requestedRef?: string;
	branch?: string;
	tag?: string;
	shallow?: boolean;
	resolvedAddresses?: string[];
	metadata?: ArtifactSourceMetadata;
	metadataFile?: ArtifactSourceFile;
	metadataError?: string;
	licenseFiles?: string[];
	failureReason?: string;
}

export interface ArtifactSourceMetadata {
	provider: "github" | "zenodo" | "figshare";
	recordId: string;
	apiUrl: string;
	version?: string;
	doi?: string;
	license?: string;
	publishedAt?: string;
	resolvedCommit?: string;
	files?: ArtifactSourceFile[];
}

export interface ArtifactManifest {
	schemaVersion: 1;
	pdfPath: string;
	pdfSha256: string;
	discoveredAt: string;
	candidates: ArtifactCandidate[];
	acquisitions: ArtifactSnapshot[];
}

export interface CorpusManifest {
	schemaVersion: 1;
	scope: CorpusScope;
	namespace: string;
	updatedAt: string;
	recordCount: number;
	searchRunCount: number;
	derivedRecordCount: number;
}

export interface DerivedRecord {
	key: string;
	paperId: string;
	operation: string;
	inputHashes: string[];
	pipelineVersion: string;
	modelVersion?: string;
	promptVersion?: string;
	normalizedConfig: unknown;
	createdAt: string;
	createdBy?: string;
	result: unknown;
}
