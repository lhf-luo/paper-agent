export interface PaperRecord {
	id: string;
	title: string;
	abstract?: string;
	authors: string[];
	year?: number;
	venue?: string;
	venueRank?: "A" | "B" | "C";
	publicationType?: string;
	identifiers: {
		doi?: string;
		arxivId?: string;
		openAlexId?: string;
		semanticScholarId?: string;
		dblpKey?: string;
		pmid?: string;
		coreId?: string;
		openCitationsId?: string;
	};
	links: Array<{ url: string; kind: string; openAccess?: boolean }>;
	citationCount?: number;
	provenance: Array<{ provider: string; query: string; retrievedAt: string }>;
	curation?: {
		tags: string[];
		userNotes: Array<{ id: string; text: string; author: string; createdAt: string }>;
		screening?: { status: string; reason?: string };
		teamReview?: { status: string; proposedBy?: string; reviewedBy?: string; reason?: string };
	};
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

export interface ConfirmationGrant {
	operationId: string;
	manifestFingerprint: string;
	confirmationToken: string;
	expiresAt: string;
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

export type ArtifactKind = "repository" | "dataset" | "supplement" | "project" | "unknown";

export interface ArtifactCandidate {
	id: string;
	url: string;
	kind: ArtifactKind;
	host: string;
	parentCandidateId?: string;
	confidence: "high" | "medium" | "low";
	sources: Array<{
		method: "pdfinfo-url" | "pdftotext" | "doi-derived";
		page?: number;
		context?: string;
		url?: string;
	}>;
}

export interface ArtifactGoldEntryView {
	id: string;
	urls: string[];
	kind?: ArtifactKind;
	pages?: number[];
	note?: string;
}

export interface ArtifactCandidateReviewState {
	candidateId: string;
	disposition: "pending" | "expected" | "ignored";
	artifactId?: string;
	kind?: ArtifactKind;
	acceptedUrls?: string[];
	pages?: number[];
	note?: string;
	reason?: string;
}

export interface ArtifactReviewQueueItem {
	slug: string;
	title: string;
	paperId?: string;
	tags: string[];
	sourceStatus: "available" | "pending-download";
	pdfAvailable: boolean;
	candidateCount: number;
	humanReviewed: boolean;
	pageCount?: number;
	reviewedPageCount: number;
	expectedArtifactCount: number;
	ignoredUrlCount: number;
	reviewer?: string;
	reviewedAt?: string;
	issues: string[];
}

export interface ArtifactReviewDetail {
	queue: ArtifactReviewQueueItem;
	source: {
		slug: string;
		title: string;
		paperId?: string;
		pdfPath: string;
		pdfSha256?: string;
		sourceUrl: string;
		status: "available" | "pending-download";
		tags?: string[];
	};
	pdfSha256: string;
	pdfBytes: number;
	pageCount: number;
	candidates: ArtifactCandidate[];
	reviewState: {
		reviewer: string;
		reviewedAt?: string;
		notes: string;
		reviewedPages: number[];
		candidateReviews: ArtifactCandidateReviewState[];
		manualArtifacts: ArtifactGoldEntryView[];
	};
}

export interface PaperAgentConfigView {
	version: 1;
	path: string;
	interface: { port: number; openBrowser: boolean };
	storage: { dataRoot?: string; corpusRoot?: string; defaultNamespace: string };
	search: {
		providers: string[];
		maxResultsPerProvider: number;
		pagesPerProvider: number;
		queryExpansions: string[];
		reuseCorpus: boolean;
	};
	model?: {
		providerId: string;
		modelId: string;
		api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
		baseUrl: string;
		apiKeyEnvironmentVariable: string;
		credentialsAvailable?: boolean;
		toolCallingVerifiedAt?: string;
		toolCallingProbe?: { supported: boolean; reason: string; latencyMs: number; checkedAt: string };
	};
	team?: {
		serverUrl: string;
		namespace: string;
		tokenEnvironmentVariable: string;
		credentialsAvailable?: boolean;
	};
	updatedAt: string;
}

export type AgentApiKind =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export type AgentMode = "once" | "persistent";
export type AgentSessionStatus = "idle" | "running" | "stopping" | "error";

export interface AgentConfiguredModelView {
	key: string;
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: AgentApiKind;
	apiKeyEnvironmentVariable?: string;
	credentialsAvailable: boolean;
}

export interface AgentConfigView {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: AgentApiKind;
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
	status: "complete" | "streaming" | "error" | "aborted";
	createdAt: string;
	error?: string;
}

export interface AgentToolView {
	id: string;
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

export interface AgentSessionSummary {
	id: string;
	title: string;
	mode: AgentMode;
	status: AgentSessionStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
	pendingUIRequests: number;
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
	| (AgentEventBase & { type: "tool"; tool: AgentToolView })
	| (AgentEventBase & { type: "ui_request"; request: AgentUIRequestView })
	| (AgentEventBase & { type: "ui_resolved"; requestId: string })
	| (AgentEventBase & { type: "notice"; level: "info" | "warning" | "error"; message: string })
	| (AgentEventBase & { type: "deleted" });
