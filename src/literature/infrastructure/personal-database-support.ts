import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
	ZoteroCollectionImportSpec,
	ZoteroPaperImportMapping,
} from "../../extensions/zotero/domain/zotero-types.ts";
import type { PaperCollection, PaperRecord, PaperVersion } from "../domain/literature-types.ts";

export interface PaperRow {
	row_id: number;
	paper_id: string;
	title: string;
	record_json: string;
}

export interface StoredVersionRow {
	version_id: string;
	file_id: string;
	version_json: string;
	relative_path: string;
	filename: string;
	sha256: string;
	bytes: number;
	content_type: string;
}

export interface PreparedFile {
	fileId: string;
	versionId: string;
	paperId: string;
	sha256: string;
	bytes: number;
	contentType: string;
	filename: string;
	relativePath: string;
	absolutePath: string;
	originalFilename: string;
	version: PaperVersion;
}

export interface PersonalBlob {
	sha256: string;
	path: string;
	existed: boolean;
}

export interface PersonalLocalImportInput {
	record: PaperRecord;
	body?: Uint8Array;
	sourcePath?: string;
	sourceUrl?: string;
	originalFilename?: string;
	zotero?: ZoteroPaperImportMapping;
}

export interface PersonalLocalImportOptions {
	collectionName?: string;
	collectionSpecs?: ZoteroCollectionImportSpec[];
	reportId: string;
	report: unknown;
}

export interface PersonalLocalImportResult {
	collection?: PaperCollection;
	collections?: PaperCollection[];
	records: PaperRecord[];
	outcomes: Array<{ paperId: string; status: "created" | "updated" | "unchanged" }>;
}

export const initializationPromises = new Map<string, Promise<void>>();

export function json(value: unknown): string {
	return JSON.stringify(value);
}

export function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

export function normalizeAuthor(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

export function pathExists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

export function safePathSegment(value: string, fallback: string): string {
	const cleaned = value
		.normalize("NFKC")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/g, "");
	const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
	const selected = !cleaned || reserved.test(cleaned) ? fallback : cleaned;
	return (
		[...selected]
			.slice(0, 150)
			.join("")
			.replace(/[. ]+$/g, "") || fallback
	);
}

export function inferredVersionKind(version: PaperVersion): NonNullable<PaperVersion["versionKind"]> {
	if (version.versionKind) return version.versionKind;
	return /arxiv\.org/i.test(`${version.sourceUrl} ${version.finalUrl}`) ? "preprint" : "published";
}

export function versionSuffix(kind: NonNullable<PaperVersion["versionKind"]>, ordinal: number, label?: string): string {
	if (kind === "published" && ordinal === 1) return "";
	if (kind === "preprint") return ordinal === 1 ? " [preprint]" : ` [preprint-${ordinal}]`;
	if (kind === "supplement") return ordinal === 1 ? " [supplement]" : ` [supplement-${ordinal}]`;
	if (kind === "translation") {
		const safeLabel = safePathSegment(label ?? "translation", "translation");
		return ordinal === 1 ? ` [${safeLabel}]` : ` [${safeLabel}-${ordinal}]`;
	}
	if (kind === "published") return ` [published-${ordinal}]`;
	return ` [version-${ordinal}]`;
}

export function readablePdfTitle(directory: string, title: string, fallback: string, suffix: string): string {
	const safe = safePathSegment(title, fallback);
	const budget = Math.max(24, 240 - resolve(directory).length - suffix.length - ".pdf".length - 1);
	return (
		[...safe]
			.slice(0, budget)
			.join("")
			.trim()
			.replace(/[. ]+$/g, "") || fallback
	);
}

export function sqlitePathLayout(root: string, namespace: string) {
	const resolvedRoot = resolve(root);
	const standardLayout = basename(resolvedRoot) === namespace && basename(dirname(resolvedRoot)) === "personal";
	const corpusRoot = standardLayout ? dirname(dirname(resolvedRoot)) : resolvedRoot;
	const dataRoot = standardLayout ? dirname(corpusRoot) : resolvedRoot;
	return {
		databasePath: join(corpusRoot, "personal.sqlite"),
		dataRoot,
		filesRoot: join(dataRoot, "files", "personal", namespace),
		legacyRoot: resolvedRoot,
	};
}

export function requireLegacyJson(path: string): string {
	return readFileSync(path, "utf8");
}
