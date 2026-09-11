import type { PaperCollection, PaperRecord } from "../../../literature/domain/literature-types.ts";

export type ZoteroSyncDirection = "zotero-to-personal" | "personal-to-zotero";

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

export interface ZoteroCreator {
	creatorType?: string;
	firstName?: string;
	lastName?: string;
	name?: string;
}

export interface ZoteroTag {
	tag: string;
	type?: number;
}

export interface ZoteroItemData {
	key?: string;
	version?: number;
	itemType: string;
	title?: string;
	creators?: ZoteroCreator[];
	abstractNote?: string;
	date?: string;
	publicationTitle?: string;
	conferenceName?: string;
	proceedingsTitle?: string;
	DOI?: string;
	url?: string;
	extra?: string;
	collections?: string[];
	tags?: ZoteroTag[];
	dateModified?: string;
	parentItem?: string;
	linkMode?: string;
	contentType?: string;
	filename?: string;
	md5?: string;
	mtime?: number | string;
	[key: string]: unknown;
}

export interface ZoteroApiItem {
	key: string;
	version: number;
	data: ZoteroItemData;
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

export interface ZoteroItemMapping {
	namespace: string;
	paperId: string;
	serverId: string;
	libraryId: string;
	itemKey: string;
	itemVersion: number;
	lastDirection: ZoteroSyncDirection;
	lastSyncedAt: string;
}

export interface ZoteroCollectionMapping {
	namespace: string;
	collectionId: string;
	serverId: string;
	libraryId: string;
	collectionKey: string;
	collectionVersion: number;
	path: string[];
	lastSyncedAt: string;
}

export interface ZoteroCollectionImportSpec {
	externalKey: string;
	name: string;
	parentExternalKey?: string;
	version: number;
	path: string[];
}

export interface ZoteroPaperImportMapping {
	serverId: string;
	libraryId: string;
	itemKey: string;
	itemVersion: number;
	collectionKeys: string[];
}

export interface ZoteroImportPreviewItem {
	itemKey: string;
	itemVersion: number;
	record?: PaperRecord;
	action: "create" | "update" | "unchanged" | "conflict" | "skip";
	collectionPaths: string[][];
	pdf?: { filename: string; bytes: number; sha256: string };
	warnings: string[];
	missingFields?: Array<"title" | "authors">;
	conflict?: string;
}

export interface ZoteroImportPreparation {
	namespace: string;
	serverId: string;
	collections: ZoteroCollectionImportSpec[];
	items: ZoteroImportPreviewItem[];
	acceptedCount: number;
	operation: ZoteroPreparedOperation;
}

export interface ZoteroImportResult {
	imported: number;
	outcomes: Array<{ paperId: string; status: "created" | "updated" | "unchanged" }>;
	records: PaperRecord[];
	failed: Array<{ itemKey: string; title: string; error: string }>;
}

export interface ZoteroPreparedOperation {
	operationId: string;
	manifestFingerprint: string;
	preparedAt: string;
	expiresAt: string;
	kind: "personal-corpus-write";
	summary: string;
	actor?: string;
	targets: Array<{ label: string; value: string; risk?: "low" | "medium" | "high" }>;
	details: Record<string, unknown>;
}

export interface ZoteroExportPreviewItem {
	paperId: string;
	title: string;
	action: "create" | "update" | "unchanged" | "conflict";
	collectionPaths: string[][];
	pdf?: { filename: string; bytes: number; sha256: string };
	itemKey?: string;
	warnings: string[];
	conflict?: string;
}

export interface ZoteroExportPreparation {
	namespace: string;
	serverId: string;
	items: ZoteroExportPreviewItem[];
	operation: ZoteroPreparedOperation;
}

export interface ZoteroExportResult {
	created: number;
	updated: number;
	unchanged: number;
	failed: Array<{ paperId: string; error: string }>;
}

export interface PersonalPaperForZotero {
	record: PaperRecord;
	collections: PaperCollection[];
	collectionPaths: PaperCollection[][];
}
