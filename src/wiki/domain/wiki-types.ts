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
	legacy?: boolean;
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
	| "legacy-source-granularity"
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
	/** Legacy page-level sources. New pages should use evidence. */
	sourceNoteIds?: string[];
	/** Legacy page-level sources. New pages should use evidence. */
	paperIds?: string[];
}

export interface WikiIngestRequest {
	namespace?: string;
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
	namespace: string;
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
	namespace: string;
	pages: WikiPageSummary[];
	tree?: WikiTreeNode[];
	sync: WikiSyncResult;
}

export interface WikiTreeNode {
	name: string;
	path: string;
	kind: "folder" | "page" | "file";
	children?: WikiTreeNode[];
	id?: string;
	title?: string;
	type?: WikiPageType;
	status?: WikiPageStatus;
}

export interface WikiSearchBackend {
	search(namespace: string, options?: WikiSearchOptions): Promise<WikiSearchResult>;
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
