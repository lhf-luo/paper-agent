export const wikiPageTypes = ["topic", "concept", "method", "system", "dataset", "synthesis", "question"] as const;
export const wikiEvidenceKinds = ["paper", "note", "artifact", "public"] as const;

export type WikiPageType = (typeof wikiPageTypes)[number];
export type WikiPageStatus = "draft" | "needs-review" | "reviewed" | "conflicted";
export type WikiEvidenceKind = (typeof wikiEvidenceKinds)[number];
export type WikiChangeAction = "create" | "update" | "no-op" | "conflict";

export interface WikiEvidenceLocator {
	pdfPage?: number;
	section?: string;
	object?: string;
	noteRevision?: number;
	noteHash?: string;
	url?: string;
	commit?: string;
	path?: string;
	line?: number;
}

export interface WikiEvidenceInput {
	id: string;
	kind: WikiEvidenceKind;
	sourceId?: string;
	paperId?: string;
	version?: string;
	locator: WikiEvidenceLocator;
}

export interface WikiEvidence extends WikiEvidenceInput {
}

export interface WikiClaim {
	id: string;
	text: string;
	evidenceIds: string[];
	inferred: boolean;
	line: number;
}

export interface WikiPageMetadata {
	id: string;
	title: string;
	type: WikiPageType;
	status: WikiPageStatus;
	aliases: string[];
	tags: string[];
	sourceNoteIds: string[];
	paperIds: string[];
	evidence: WikiEvidence[];
	createdAt: string;
	updatedAt: string;
}

export interface WikiPage extends WikiPageMetadata {
	relativePath: string;
	markdown: string;
	contentHash: string;
	links: string[];
	claims: WikiClaim[];
}

export interface WikiPaperDependencyPage {
	id: string;
	title: string;
	contentHash: string;
	evidenceCount: number;
	mixed: boolean;
}

export interface WikiPaperDependencyPreview {
	paperIds: string[];
	fingerprint: string;
	dependencies: Array<{ paperId: string; pages: WikiPaperDependencyPage[] }>;
}

export interface WikiMatch {
	reason: "title" | "alias" | "chunk" | "source" | "related";
	score: number;
	heading?: string;
	snippet?: string;
	evidenceIds: string[];
}

export interface WikiPageSummary extends WikiPageMetadata {
	relativePath: string;
	contentHash: string;
	snippet?: string;
	match?: WikiMatch;
}

export type WikiLintCode =
	| "invalid-frontmatter"
	| "duplicate-id"
	| "duplicate-title-alias"
	| "broken-link"
	| "self-link"
	| "missing-source"
	| "stale-source"
	| "missing-evidence"
	| "unused-evidence"
	| "invalid-evidence-locator"
	| "empty-page"
	| "missing-source-list"
	| "conflicted-status"
	| "near-duplicate-page"
	| "index-mismatch";

export interface WikiLintIssue {
	severity: "error" | "warning" | "info";
	code: WikiLintCode;
	path: string;
	message: string;
	pageId?: string;
	evidenceId?: string;
	claimId?: string;
	sourceKind?: "paper" | "note";
	sourceId?: string;
}

export interface WikiSyncResult {
	pageCount: number;
	issues: WikiLintIssue[];
	indexedAt: string;
}

export interface IngestWikiPageInput {
	pageId?: string;
	expectedContentHash?: string;
	title: string;
	type: WikiPageType;
	markdown: string;
	aliases?: string[];
	tags?: string[];
	evidence?: WikiEvidenceInput[];
}

export interface WikiIngestRequest {
	summary: string;
	changes: IngestWikiPageInput[];
}

export interface WikiSourceSnapshot {
	kind: "paper" | "note";
	id: string;
	title: string;
	version: string;
	revision?: number;
	updatedAt?: string;
}

export interface WikiChangePreview {
	action: WikiChangeAction;
	pageId?: string;
	title: string;
	type: WikiPageType;
	relativePath?: string;
	expectedContentHash?: string;
	currentContentHash?: string;
	diff: string[];
	evidence: WikiEvidence[];
	sourceSnapshots: WikiSourceSnapshot[];
	issues: WikiLintIssue[];
	change: IngestWikiPageInput;
}

export interface WikiIngestPreview {
	summary: string;
	fingerprint: string;
	generatedAt: string;
	changes: WikiChangePreview[];
	issues: WikiLintIssue[];
}

export interface WikiIngestResult {
	pages: WikiPage[];
	previewFingerprint: string;
}

export interface WikiSourcePageDeletionEntry {
	id: string;
	title: string;
	type: WikiPageType;
	status: WikiPageStatus;
	relativePath: string;
	contentHash: string;
	matchingEvidenceIds: string[];
	otherSources: string[];
}

export interface WikiSourcePageDeletionBacklink {
	pageId: string;
	title: string;
	targetPageIds: string[];
}

export interface WikiSourcePageDeletionPreview {
	paperId: string;
	includeMixedPageIds: string[];
	fingerprint: string;
	generatedAt: string;
	deletablePages: WikiSourcePageDeletionEntry[];
	mixedPages: WikiSourcePageDeletionEntry[];
	targetPages: WikiSourcePageDeletionEntry[];
	externalBacklinks: WikiSourcePageDeletionBacklink[];
	blocked: boolean;
}

export interface WikiSourcePageDeletionResult {
	deletedPages: WikiSourcePageDeletionEntry[];
	deletedEvidenceCount: number;
	previewFingerprint: string;
	lint: WikiSyncResult;
}

export interface WikiSearchOptions {
	query?: string;
	pageId?: string;
	paperId?: string;
	noteId?: string;
	type?: WikiPageType | "all";
	status?: WikiPageStatus | "all";
	limit?: number;
	includeRelated?: boolean;
}

export interface WikiSearchResult {
	pages: WikiPageSummary[];
	tree?: WikiTreeNode[];
	sync: WikiSyncResult;
}

export interface WikiManagementFile {
	name: string;
	path: string;
	markdown: string;
}

export interface WikiTreeNode {
	name: string;
	path: string;
	kind: "folder" | "page" | "management" | "file";
	children?: WikiTreeNode[];
	id?: string;
	title?: string;
	type?: WikiPageType;
	status?: WikiPageStatus;
}

export interface WikiSearchBackend {
	search(options?: WikiSearchOptions): Promise<WikiSearchResult>;
}

export function isWikiPageType(value: unknown): value is WikiPageType {
	return typeof value === "string" && (wikiPageTypes as readonly string[]).includes(value);
}

export function isWikiEvidenceKind(value: unknown): value is WikiEvidenceKind {
	return typeof value === "string" && (wikiEvidenceKinds as readonly string[]).includes(value);
}

export function isWikiPageStatus(value: unknown): value is WikiPageStatus {
	return ["draft", "needs-review", "reviewed", "conflicted"].includes(String(value));
}
