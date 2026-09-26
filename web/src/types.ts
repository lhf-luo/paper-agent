export interface PaperRecord {
	id: string;
	title: string;
	abstract?: string;
	authors: string[];
	year?: number;
	venue?: string;
	venueRank?: "A" | "B" | "C";
	publicationType?: string;
	metadataConflicts?: Partial<
		Record<
			| "title"
			| "authors"
			| "abstract"
			| "year"
			| "venue"
			| "venueRank"
			| "publicationType"
			| "citationCount"
			| "referencedWorks"
			| "citedByApiUrl"
			| "doi"
			| "arxivId"
			| "openAlexId"
			| "semanticScholarId"
			| "dblpKey"
			| "coreId"
			| "openCitationsId",
			Array<{ value: string | number | string[]; sources: string[] }>
		>
	>;
	identifiers: {
		doi?: string;
		arxivId?: string;
		openAlexId?: string;
		semanticScholarId?: string;
		dblpKey?: string;
		coreId?: string;
		openCitationsId?: string;
	};
	links: Array<{ url: string; kind: string; openAccess?: boolean }>;
	citationCount?: number;
	provenance: Array<{ provider: string; query: string; retrievedAt: string }>;
	collectionIds?: string[];
	curation?: {
		tags: string[];
		userNotes: Array<{ id: string; text: string; author: string; createdAt: string }>;
		screening?: { status: string; reason?: string };
		teamReview?: {
			status: string;
			proposedBy?: string;
			proposedById?: string;
			proposedAt?: string;
			reviewedBy?: string;
			reviewedAt?: string;
			reason?: string;
			revision?: boolean;
		};
	};
}

/** 文献分类(集合)。一篇论文可属于多个分类, 语义同 Zotero collection。 */
export interface PaperCollection {
	id: string;
	name: string;
	parentId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CollectionMembershipIndex {
	namespace: string;
	allPaperIds: string[];
	uncategorizedPaperIds: string[];
	collectionPaperIds: Record<string, string[]>;
}

export interface ResearchNotePaper {
	id: string;
	title: string;
}

export interface ResearchNoteSummary {
	id: string;
	title: string;
	relativePath: string;
	folderId?: string;
	folderPath?: string;
	templateId?: string;
	revision: number;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
	papers: ResearchNotePaper[];
}

export interface ResearchNoteFolder {
	id: string;
	name: string;
	parentId?: string;
	relativePath: string;
	createdAt: string;
	updatedAt: string;
}

export interface ResearchNote extends ResearchNoteSummary {
	markdown: string;
}

export interface ResearchNoteTemplate {
	id: string;
	name: string;
	filename?: string;
	markdown: string;
}

export interface ResearchNoteNavigation {
	namespace: string;
	noteId?: string;
	paperId?: string;
}

export interface BackgroundJob {
	id: string;
	type: string;
	status: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
	input: unknown;
	result?: any;
	error?: string;
	progress: number;
	message?: string;
	attempts: number;
	maxAttempts: number;
	createdAt: string;
	updatedAt: string;
}

export interface PdfTranslationEngineStatus {
	available: boolean;
	engine: "pdf2zh-next";
	command: string;
	version?: string;
	activeModel?: string;
	reason?: string;
}

export interface PdfTranslationResult {
	paperId: string;
	namespace: string;
	sourceSha256: string;
	version: {
		sha256: string;
		bytes: number;
		blobPath: string;
		versionKind: "translation";
		versionLabel: string;
		retrievedAt: string;
	};
	engine: "pdf2zh-next";
	engineVersion?: string;
	model: string;
	outputMode: "mono" | "dual";
}

export interface PaperVersionView {
	paperId: string;
	sourceUrl: string;
	finalUrl: string;
	retrievedAt: string;
	sha256: string;
	bytes: number;
	blobPath: string;
	contentType: string;
	versionKind?: "published" | "preprint" | "supplement" | "translation" | "unknown";
	versionLabel?: string;
	relatedVersionSha256?: string;
	isPreferred?: boolean;
	translation?: {
		engine: "pdf2zh-next";
		engineVersion?: string;
		model: string;
		sourceLanguage: string;
		targetLanguage: string;
		outputMode: "mono" | "dual";
	};
}

export interface PdfMaterialRecord {
	id: string;
	namespace: string;
	paperId: string;
	sourceSha256: string;
	path: string;
	modelVersion: "pipeline" | "vlm";
	pageCount: number;
	fileCount: number;
	bytes: number;
	updatedAt: string;
}

export interface MineruStatus {
	configured: boolean;
	available: boolean;
	baseUrl: string;
	modelVersion: "pipeline" | "vlm";
	language: string;
	archiveExtractor?: "unzip" | "tar";
	reason?: string;
}

export interface MineruMaterialView {
	paperId: string;
	namespace: string;
	material?: PdfMaterialRecord;
	preferredSha256?: string;
	stale: boolean;
	missing?: boolean;
}

export interface AgentSearchRunSummary {
	id: string;
	queries: string[];
	providers: string[];
	startedAt: string;
	completedAt: string;
	resultCount: number;
	deduplicatedCount: number;
	sourceCounts: Record<string, number>;
	failures: Array<{ provider: string; message: string }>;
	scope: string;
	mode: string;
	namespace: string;
}

export interface AgentSearchRun {
	id: string;
	startedAt: string;
	completedAt: string;
	queries: string[];
	providers: string[];
	results: PaperRecord[];
	deduplicatedCount: number;
	providerHealth?: Record<string, { status: string; recordCount: number; failureCount: number; message?: string }>;
}

export interface PreparedOperation {
	operationId: string;
	manifestFingerprint: string;
	preparedAt: string;
	expiresAt: string;
	kind: string;
	summary: string;
	targets: Array<{ label: string; value: string; risk?: string }>;
	details: Record<string, unknown>;
}

export interface OperationConfirmationSettingsView {
	requireAgentWriteConfirmation: boolean;
	requirePersonalLibraryWriteConfirmation: boolean;
	requirePersonalLibraryDeleteConfirmation: boolean;
	requireResearchConfirmation: boolean;
	requirePdfArtifactConfirmation: boolean;
	requireWikiWriteConfirmation: boolean;
}

export interface WikiLintIssue {
	severity: "error" | "warning" | "info";
	code: string;
	path: string;
	message: string;
	pageId?: string;
	evidenceId?: string;
	claimId?: string;
	sourceKind?: "paper" | "note";
	sourceId?: string;
}

export interface WikiSourcePageDeletionEntry {
	id: string;
	title: string;
	type: WikiPageSummary["type"];
	status: WikiPageSummary["status"];
	relativePath: string;
	contentHash: string;
	matchingEvidenceIds: string[];
	otherSources: string[];
}

export interface WikiSourcePageDeletionPreview {
	namespace: string;
	paperId: string;
	includeMixedPageIds: string[];
	fingerprint: string;
	generatedAt: string;
	deletablePages: WikiSourcePageDeletionEntry[];
	mixedPages: WikiSourcePageDeletionEntry[];
	targetPages: WikiSourcePageDeletionEntry[];
	externalBacklinks: Array<{ pageId: string; title: string; targetPageIds: string[] }>;
	blocked: boolean;
}

export interface WikiEvidence {
	id: string;
	kind: "paper" | "note" | "artifact" | "public";
	sourceId?: string;
	paperId?: string;
	version?: string;
	locator: {
		pdfPage?: number;
		section?: string;
		object?: string;
		noteRevision?: number;
		noteHash?: string;
		url?: string;
		commit?: string;
		path?: string;
		line?: number;
	};
	legacy?: boolean;
}

export interface WikiClaim {
	id: string;
	text: string;
	evidenceIds: string[];
	inferred: boolean;
	line: number;
}

export interface WikiPageSummary {
	id: string;
	title: string;
	type: "topic" | "concept" | "method" | "system" | "dataset" | "synthesis" | "question";
	status: "draft" | "needs-review" | "reviewed" | "conflicted";
	relativePath: string;
	aliases: string[];
	tags: string[];
	sourceNoteIds: string[];
	paperIds: string[];
	evidence: WikiEvidence[];
	createdAt: string;
	updatedAt: string;
	contentHash: string;
	snippet?: string;
	match?: {
		reason: "title" | "alias" | "chunk" | "source" | "related";
		score: number;
		heading?: string;
		snippet?: string;
		evidenceIds: string[];
	};
}

export interface WikiPage extends WikiPageSummary {
	markdown: string;
	links: string[];
	claims: WikiClaim[];
}

export interface WikiTreeNode {
	name: string;
	path: string;
	kind: "folder" | "page" | "management" | "file";
	children?: WikiTreeNode[];
	id?: string;
	title?: string;
	type?: WikiPageSummary["type"];
	status?: WikiPageSummary["status"];
}

export interface WikiManagementFile {
	name: string;
	path: string;
	markdown: string;
}

export interface ConfirmationGrant {
	operationId: string;
	manifestFingerprint: string;
	confirmationToken: string;
	expiresAt: string;
}

export interface TeamAccessStatus {
	configured: boolean;
	connected: boolean;
	source: "access-file" | null;
	serverUrl?: string;
	namespace?: string;
	hasLocalAccess?: boolean;
	reason?: string;
	identity?: {
		id: string;
		name: string;
		roles: Array<"reader" | "contributor" | "reviewer" | "admin">;
		namespaces: string[];
		expiresAt?: string;
	};
}

export interface LocalPdfImportWarning {
	stage: "pdfinfo" | "text" | "ocr" | "provider";
	message: string;
	provider?: string;
}

export interface LocalPdfImportFilePreview {
	id: string;
	filename: string;
	bytes: number;
	sha256: string;
	status: "ready" | "needs_metadata";
	record?: PaperRecord;
	metadataSource?: "pdfinfo" | "text" | "ocr" | "doi";
	warnings: LocalPdfImportWarning[];
	needsMetadata?: {
		source: string;
		reason: "needs_metadata";
		missingFields: Array<"title" | "authors">;
		detail: string;
		warnings: LocalPdfImportWarning[];
	};
	action?: "created" | "updated" | "unchanged";
}

export interface LocalPdfImportBatchView {
	id: string;
	namespace: string;
	collection?: PaperCollection;
	expiresAt: string;
	files: LocalPdfImportFilePreview[];
	acceptedCount: number;
	needsMetadataCount: number;
	providerWarnings: LocalPdfImportWarning[];
	possibleDuplicates: Array<{
		leftId: string;
		rightId: string;
		titleSimilarity: number;
		reason: string;
	}>;
	operation?: PreparedOperation;
}

export interface ZoteroStatus {
	running: boolean;
	localApiEnabled: boolean;
	writeAuthorized: boolean;
	serverId?: string;
	message: string;
}

export interface ZoteroCollectionEntry {
	key: string;
	version: number;
	name: string;
	parentKey?: string;
	path: string[];
}

export interface ZoteroLibraryItem {
	key: string;
	version: number;
	title: string;
	authors: string[];
	year?: number;
	itemType: string;
	collectionKeys: string[];
	collectionPaths: string[][];
	valid: boolean;
	missingFields: Array<"title" | "authors">;
}

export interface ZoteroImportPreparation {
	namespace: string;
	serverId: string;
	acceptedCount: number;
	items: Array<{
		itemKey: string;
		itemVersion: number;
		record?: PaperRecord;
		action: "create" | "update" | "unchanged" | "conflict" | "skip";
		collectionPaths: string[][];
		pdf?: { filename: string; bytes: number; sha256: string };
		warnings: string[];
		missingFields?: Array<"title" | "authors">;
		conflict?: string;
	}>;
	operation: PreparedOperation;
}

export interface ZoteroImportResult {
	imported: number;
	outcomes: Array<{ paperId: string; status: "created" | "updated" | "unchanged" }>;
	records: PaperRecord[];
	failed: Array<{ itemKey: string; title: string; error: string }>;
}

export interface ZoteroExportPreparation {
	namespace: string;
	serverId: string;
	items: Array<{
		paperId: string;
		title: string;
		action: "create" | "update" | "unchanged" | "conflict";
		collectionPaths: string[][];
		pdf?: { filename: string; bytes: number; sha256: string };
		warnings: string[];
		conflict?: string;
	}>;
	operation: PreparedOperation;
}

export interface PaperAsset {
	id: string;
	type: "figure" | "table" | "algorithm" | "listing";
	identifier: string;
	page: number;
	caption: string;
	section?: string;
	candidateRegion: { x: number; y: number; width: number; height: number };
	captionBox: { x: number; y: number; width: number; height: number };
	regionConfidence: string;
	subfigureRegions?: Array<{
		label: string;
		region: { x: number; y: number; width: number; height: number };
		confidence: string;
	}>;
	mentions: Array<{
		page: number;
		section?: string;
		context: string;
		matchedText: string;
		lineBox?: { x: number; y: number; width: number; height: number };
		confidence?: string;
	}>;
	continuationRegions?: Array<{
		page: number;
		region: { x: number; y: number; width: number; height: number };
		confidence: string;
	}>;
	manualCorrection?: { id: string; author: string; createdAt: string; note?: string };
}

export interface PaperAgentConfigView {
	version: 1;
	path: string;
	interface: { port: number; openBrowser: boolean };
	readerTranslation: { defaultProvider: "google" | "deepl" | "youdao" | "baidu" };
	storage: { dataRoot?: string; corpusRoot?: string; defaultNamespace: string };
	externalTools: { commandDirectories: string[] };
	confirmations: OperationConfirmationSettingsView;
	pdfTranslation: { engine: "siliconflowfree" | "active-model"; modelKey?: string; command?: string };
	mineru: { baseUrl: string; modelVersion: "pipeline" | "vlm"; language: string };
	wiki: { obsidianPath?: string };
	credentials?: Record<string, string | undefined>;
	search: {
		providers: string[];
		doiEnrichmentProviders: string[];
		maxResultsPerProvider: number;
		pagesPerProvider: number;
		queryExpansions: string[];
		reuseCorpus: boolean;
	};
	network?: { proxyEnabled?: boolean; proxyUrl?: string; noProxyHosts?: string[] };
	model?: ModelConfigView;
	models?: ModelConfigView[];
	updatedAt: string;
}

/**
 * 持久化的模型声明。设置页会把整个配置视图原样回传保存，所以视图必须携带全部
 * 元数据；缺少的字段会被服务端校验层用默认值补齐，从而静默重置用户的设置。
 */
export interface ModelConfigView {
	name?: string;
	providerId: string;
	modelId: string;
	api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
	baseUrl: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	/** 保存时回传 `[redacted]` 表示沿用服务端已存的密钥。 */
	apiKey?: string;
	apiKeyEnvironmentVariable?: string;
	headers?: Record<string, string>;
	credentialsAvailable?: boolean;
	toolCallingVerifiedAt?: string;
	toolCallingProbe?: { supported: boolean; reason: string; latencyMs: number; checkedAt: string };
}

export type AgentApiKind = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export type AgentMode = "once" | "persistent";
export type AgentSessionStatus = "idle" | "running" | "stopping" | "error";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentPermissionMode = "ask" | "auto";

export interface AgentConfiguredModelView {
	key: string;
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: AgentApiKind;
	input: Array<"text" | "image">;
	apiKeyEnvironmentVariable?: string;
	credentialsAvailable: boolean;
}

export interface AgentConfigView {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: AgentApiKind;
	input: Array<"text" | "image">;
	apiKeyEnvironmentVariable?: string;
	configured: boolean;
	credentialsAvailable: boolean;
	credentialSource: "memory" | "config" | "environment" | "none";
	configuredModels: AgentConfiguredModelView[];
}

export interface AgentMessageView {
	id: string;
	role: "user" | "assistant";
	content: string;
	attachmentNames?: string[];
	thinking?: string;
	status: "complete" | "streaming" | "error" | "aborted";
	createdAt: string;
	error?: string;
}

export interface AgentToolView {
	id: string;
	assistantMessageId?: string;
	name: string;
	status: "running" | "succeeded" | "failed";
	input?: string;
	output?: string;
	startedAt: string;
	finishedAt?: string;
}

export interface AgentUIRequestView {
	id: string;
	type: "confirm" | "select" | "input";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	createdAt: string;
	expiresAt: string;
}

export interface AgentSessionContext {
	kind: "paper";
	namespace: string;
	paperId: string;
}

export interface AgentSessionSummary {
	id: string;
	title: string;
	mode: AgentMode;
	context?: AgentSessionContext;
	status: AgentSessionStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
	pendingUIRequests: number;
	thinkingLevel?: AgentThinkingLevel;
	permissionMode?: AgentPermissionMode;
}

export interface AgentSessionSnapshot extends AgentSessionSummary {
	messages: AgentMessageView[];
	tools: AgentToolView[];
	uiRequests: AgentUIRequestView[];
}

interface AgentEventBase {
	id: number;
	sessionId: string;
	createdAt: string;
}

export type AgentEvent =
	| (AgentEventBase & { type: "session"; session: AgentSessionSummary })
	| (AgentEventBase & { type: "message"; message: AgentMessageView })
	| (AgentEventBase & { type: "message_delta"; messageId: string; delta: string })
	| (AgentEventBase & { type: "thinking_delta"; messageId: string; delta: string })
	| (AgentEventBase & { type: "tool"; tool: AgentToolView })
	| (AgentEventBase & { type: "ui_request"; request: AgentUIRequestView })
	| (AgentEventBase & { type: "ui_resolved"; requestId: string })
	| (AgentEventBase & { type: "notice"; level: "info" | "warning" | "error"; message: string })
	| (AgentEventBase & { type: "deleted" });

export type Page =
	| "dashboard"
	| "search"
	| "agent"
	| "library"
	| "tasks"
	| "pdf"
	| "team"
	| "research"
	| "wiki"
	| "settings"
	| "reader";

export interface ApplicationStatus {
	ok: boolean;
	projectRoot: string;
	dataRoot: string;
	corpusRoot: string;
	defaultNamespace: string;
	personalNamespaces: string[];
	defaultRecordCount: number;
	confirmations: OperationConfirmationSettingsView;
	jobs: { queued: number; running: number; failed: number };
}

export interface ReaderState {
	title: string;
	url: string;
	pdfPath?: string;
	paperId?: string;
	namespace?: string;
	sha256?: string;
	bytes?: number;
	retrievedAt?: string;
	versionKind?: "published" | "preprint" | "supplement" | "translation" | "unknown";
	versionLabel?: string;
	translationOutputMode?: "mono" | "dual";
}

export type ReaderWorkspaceTab =
	| { id: "agent"; kind: "agent"; title: string }
	| { id: string; kind: "note"; noteId: string; title: string }
	| { id: "new-note"; kind: "new-note"; title: string };

export interface ReaderPaperDetails {
	paper: PaperRecord;
	versions: PaperVersionView[];
}

export interface LocalPdfImportIssue {
	filename: string;
	message: string;
}

export type AutomatedResearchDepth = "quick" | "methods" | "full" | "reproduce";

export interface AutomatedResearchPlan {
	depth: AutomatedResearchDepth;
	depthLabel: string;
	stages: Array<{ id: string; label: string; purpose: string }>;
	unattended: true;
	readOnly: true;
	humanGates: string[];
}
