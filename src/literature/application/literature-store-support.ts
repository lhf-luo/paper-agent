import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
	ZoteroCollectionImportSpec,
	ZoteroPaperImportMapping,
} from "../../extensions/zotero/domain/zotero-types.ts";
import type { CorpusScope, PaperCollection, PaperRecord } from "../domain/literature-types.ts";

export function safeSegment(value: string, label: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
		throw new Error(`${label} must use 1-64 letters, numbers, dots, underscores, or hyphens`);
	}
	return value;
}

export function resolveCorpusRoot(cwd: string, scope: CorpusScope, namespace: string, configuredRoot?: string): string {
	const base = configuredRoot ? resolve(cwd, configuredRoot) : resolve(cwd, ".paper-agent", "corpus");
	return join(base, scope, safeSegment(namespace, "namespace"));
}

export interface LocalPaperImportInput {
	record: PaperRecord;
	body?: Uint8Array;
	sourcePath?: string;
	sourceUrl?: string;
	originalFilename?: string;
	zotero?: ZoteroPaperImportMapping;
}

export interface LocalPaperImportOptions {
	collectionName?: string;
	collectionSpecs?: ZoteroCollectionImportSpec[];
	reportId: string;
	report: unknown;
}

export interface LocalPaperImportResult {
	collection?: PaperCollection;
	collections?: PaperCollection[];
	records: PaperRecord[];
	outcomes: Array<{ paperId: string; status: "created" | "updated" | "unchanged" }>;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, path);
	} catch (error) {
		try {
			await unlink(temporaryPath);
		} catch {
			// Best-effort cleanup; the primary write error is more useful to the caller.
		}
		throw error;
	}
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

export function csvField(value: unknown): string {
	const text = value === undefined || value === null ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function bibKey(record: PaperRecord, index: number): string {
	const author = record.authors[0]?.split(/\s+/).at(-1)?.replace(/\W+/g, "") || "paper";
	return (author + (record.year ?? "nd") + (index + 1)).toLowerCase();
}

export function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export function uniqueNormalized(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		const key = trimmed.toLowerCase();
		if (!trimmed || seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	return result;
}
