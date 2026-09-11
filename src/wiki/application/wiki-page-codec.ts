import { createHash } from "node:crypto";
import { readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { extractWikiClaims } from "../domain/wiki-content.ts";
import {
	isWikiEvidenceKind,
	isWikiPageStatus,
	isWikiPageType,
	type IngestWikiPageInput,
	type WikiEvidence,
	type WikiEvidenceKind,
	type WikiLintCode,
	type WikiLintIssue,
	type WikiPage,
	type WikiPageMetadata,
	type WikiPageType,
} from "../domain/wiki-types.ts";

export const MAX_WIKI_PAGE_BYTES = 2 * 1024 * 1024;
export const WIKI_INDEX_FILENAME = "index.md";
export const WIKI_LOG_FILENAME = "log.md";
export const WIKI_RESERVED_FILES = new Set([WIKI_INDEX_FILENAME, WIKI_LOG_FILENAME]);
export const WIKI_TYPE_DIRECTORIES = {
	topic: "topics",
	concept: "concepts",
	method: "methods",
	system: "systems",
	dataset: "datasets",
	synthesis: "syntheses",
	question: "questions",
} as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseWikiPage(source: string, relativePath: string): WikiPage {
	const match = FRONTMATTER.exec(source);
	if (!match) throw new Error("缺少 YAML frontmatter");
	const raw = parse(match[1]);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("YAML frontmatter 必须是对象");
	const value = raw as Record<string, unknown>;
	const id = boundedText(value.id, "id", 128);
	const title = boundedText(value.title, "title", 300);
	if (!isWikiPageType(value.type)) throw new Error(`不支持的 Wiki 页面类型：${String(value.type)}`);
	if (!isWikiPageStatus(value.status)) throw new Error(`不支持的 Wiki 页面状态：${String(value.status)}`);
	const rawEvidence = parseEvidence(value.evidence);
	const paperIds = stringArray(value.paper_ids);
	const sourceNoteIds = stringArray(value.source_notes);
	for (const paperId of paperIds) {
		if (!rawEvidence.some((item) => item.kind === "paper" && item.sourceId === paperId)) {
			rawEvidence.push({
				id: nextEvidenceId(rawEvidence),
				kind: "paper",
				sourceId: paperId,
				locator: {},
				legacy: true,
			});
		}
	}
	for (const noteId of sourceNoteIds) {
		if (!rawEvidence.some((item) => item.kind === "note" && item.sourceId === noteId)) {
			rawEvidence.push({
				id: nextEvidenceId(rawEvidence),
				kind: "note",
				sourceId: noteId,
				locator: {},
				legacy: true,
			});
		}
	}
	const markdown = source.slice(match[0].length);
	return {
		id,
		title,
		type: value.type,
		status: value.status,
		aliases: stringArray(value.aliases),
		tags: stringArray(value.tags),
		sourceNoteIds: [...new Set([...sourceNoteIds, ...evidenceSourceIds(rawEvidence, "note")])],
		paperIds: [...new Set([...paperIds, ...evidencePaperIds(rawEvidence)])],
		evidence: rawEvidence,
		createdAt: isoDate(value.created_at, "created_at"),
		updatedAt: isoDate(value.updated_at, "updated_at"),
		relativePath,
		markdown,
		contentHash: createHash("sha256").update(source).digest("hex"),
		links: [...source.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((item) => item[1].trim()),
		claims: extractWikiClaims(markdown),
	};
}

export function renderWikiPage(metadata: WikiPageMetadata, markdown: string): string {
	const frontmatter = stringify({
		id: metadata.id,
		title: metadata.title,
		type: metadata.type,
		status: metadata.status,
		aliases: metadata.aliases,
		tags: metadata.tags,
		source_notes: metadata.sourceNoteIds,
		paper_ids: metadata.paperIds,
		evidence: metadata.evidence.map((item) => ({
			id: item.id,
			kind: item.kind,
			...(item.sourceId ? { source_id: item.sourceId } : {}),
			...(item.paperId ? { paper_id: item.paperId } : {}),
			...(item.version ? { version: item.version } : {}),
			locator: renderLocator(item.locator),
		})),
		created_at: metadata.createdAt,
		updated_at: metadata.updatedAt,
	});
	return `---\n${frontmatter}---\n${markdown.trim()}\n`;
}

export async function markdownFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	const pending = [root];
	while (pending.length) {
		const directory = pending.pop()!;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			if (WIKI_RESERVED_FILES.has(entry.name.toLowerCase())) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(path);
		}
	}
	return result.sort();
}

export async function writeAtomic(path: string, content: string): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temporary, content, "utf8");
	await rename(temporary, path);
}

export function previewPage(change: { title: string; type: WikiPageType; change: IngestWikiPageInput; evidence: WikiEvidence[] }, existing?: WikiPage): WikiPage {
	const id = existing?.id ?? `wiki-preview-${normalizedPreviewLabel(change.title).slice(0, 32)}`;
	const metadata: WikiPageMetadata = {
		id,
		title: change.title,
		type: change.type,
		status: existing?.status ?? "draft",
		aliases: uniqueStrings(change.change.aliases ?? []),
		tags: uniqueStrings(change.change.tags ?? []),
		sourceNoteIds: evidenceSourceIds(change.evidence, "note"),
		paperIds: evidencePaperIds(change.evidence),
		evidence: change.evidence,
		createdAt: existing?.createdAt ?? new Date(0).toISOString(),
		updatedAt: existing?.updatedAt ?? new Date(0).toISOString(),
	};
	return {
		...metadata,
		relativePath: existing?.relativePath ?? `${WIKI_TYPE_DIRECTORIES[change.type]}/${safeFilename(change.title) || "page"}.md`,
		markdown: change.change.markdown,
		contentHash: "",
		links: [],
		claims: extractWikiClaims(change.change.markdown),
	};
}

export function validateEvidenceClaims(
	markdown: string,
	evidence: WikiEvidence[],
	issues: WikiLintIssue[],
): void {
	const referenced = new Set(extractWikiClaims(markdown).flatMap((claim) => claim.evidenceIds));
	const available = new Set(evidence.map((item) => item.id));
	for (const evidenceId of referenced) {
		if (!available.has(evidenceId)) {
			issues.push(issue("error", "missing-evidence", `正文引用了不存在的证据 ${evidenceId}`, evidenceId));
		}
	}
	if (evidence.length && referenced.size === 0) {
		issues.push(issue("warning", "missing-evidence", "页面声明了证据，但正文没有 [E#] 引用"));
	}
}

export function changeSetFingerprint(
	namespace: string,
	summary: string,
	changes: IngestWikiPageInput[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonicalJson({
					namespace,
					summary,
					changes: changes.map((change) => ({
						pageId: change.pageId ?? null,
						expectedContentHash: change.expectedContentHash ?? null,
						title: change.title,
						type: change.type,
						aliases: uniqueStrings(change.aliases ?? []),
						tags: uniqueStrings(change.tags ?? []),
						markdown: change.markdown,
						evidence: change.evidence ?? [],
					})),
				}),
			),
		)
		.digest("hex");
}

export function evidencePaperIds(evidence: WikiEvidence[]): string[] {
	return [
		...new Set(
			evidence
				.flatMap((item) => [item.kind === "paper" ? item.sourceId : undefined, item.paperId])
				.filter((value): value is string => Boolean(value)),
		),
	];
}

export function evidenceSourceIds(evidence: WikiEvidence[], kind: WikiEvidenceKind): string[] {
	return [...new Set(evidence.filter((item) => item.kind === kind && item.sourceId).map((item) => item.sourceId!))];
}

export function nextEvidenceId(evidence: Array<{ id: string }>): string {
	const existing = new Set(evidence.map((item) => item.id));
	let index = 1;
	while (existing.has(`E${index}`)) index++;
	return `E${index}`;
}

export function issue(
	severity: WikiLintIssue["severity"],
	code: WikiLintCode,
	message: string,
	evidenceId?: string,
): WikiLintIssue {
	return { severity, code, path: ".", message, ...(evidenceId ? { evidenceId } : {}) };
}

export function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 200);
}

export function boundedText(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
	const text = value.trim();
	if (Buffer.byteLength(text, "utf8") > max) throw new Error(`${field} exceeds ${max} bytes`);
	return text;
}

export function stringArray(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error("frontmatter 列表字段必须是字符串数组");
	return uniqueStrings(value as string[]);
}

export function isoDate(value: unknown, field: string): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${field} 必须是 ISO 时间`);
	return new Date(value).toISOString();
}

export function safeFilename(value: string): string {
	const cleaned = value
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/g, "")
		.trim();
	return cleaned.slice(0, 120);
}

export async function newWikiRelativePath(
	metadata: WikiPageMetadata,
	exists: (relativePath: string) => Promise<boolean>,
): Promise<string> {
	const stem = safeFilename(metadata.title);
	const directory = WIKI_TYPE_DIRECTORIES[metadata.type];
	const first = `${directory}/${stem || metadata.id}.md`;
	if (!(await exists(first))) return first;
	return `${directory}/${stem || "page"} [${metadata.id.slice(-8)}].md`;
}

export function safeWikiPath(directory: string, relativePath: string): string {
	const path = resolve(directory, relativePath);
	const inside = relative(directory, path);
	if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
		throw new Error("Wiki page path leaves the namespace vault");
	}
	return path;
}

function parseEvidence(value: unknown): WikiEvidence[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("evidence 必须是数组");
	const seen = new Set<string>();
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("evidence 项必须是对象");
		const raw = item as Record<string, unknown>;
		const id = boundedText(raw.id, "evidence.id", 128);
		if (!/^E[1-9]\d*$/.test(id)) throw new Error(`evidence.id 格式无效：${id}`);
		if (seen.has(id)) throw new Error(`evidence.id 重复：${id}`);
		seen.add(id);
		if (!isWikiEvidenceKind(raw.kind)) throw new Error(`不支持的 evidence.kind：${String(raw.kind)}`);
		const locator = raw.locator;
		if (locator !== undefined && (!locator || typeof locator !== "object" || Array.isArray(locator))) {
			throw new Error("evidence.locator 必须是对象");
		}
		return {
			id,
			kind: raw.kind,
			...(typeof raw.source_id === "string" && raw.source_id.trim() ? { sourceId: raw.source_id.trim() } : {}),
			...(typeof raw.paper_id === "string" && raw.paper_id.trim() ? { paperId: raw.paper_id.trim() } : {}),
			...(typeof raw.version === "string" && raw.version.trim() ? { version: raw.version.trim() } : {}),
			locator: locatorFromRaw(locator),
		};
	});
}

function renderLocator(locator: WikiEvidence["locator"]): Record<string, string | number> {
	return {
		...(locator.pdfPage !== undefined ? { pdf_page: locator.pdfPage } : {}),
		...(locator.section !== undefined ? { section: locator.section } : {}),
		...(locator.object !== undefined ? { object: locator.object } : {}),
		...(locator.noteRevision !== undefined ? { note_revision: locator.noteRevision } : {}),
		...(locator.noteHash !== undefined ? { note_hash: locator.noteHash } : {}),
		...(locator.url !== undefined ? { url: locator.url } : {}),
		...(locator.commit !== undefined ? { commit: locator.commit } : {}),
		...(locator.path !== undefined ? { path: locator.path } : {}),
		...(locator.line !== undefined ? { line: locator.line } : {}),
	};
}

function locatorFromRaw(value: unknown): WikiEvidence["locator"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	return {
		...(Number.isInteger(raw.pdf_page)
			? { pdfPage: Number(raw.pdf_page) }
			: Number.isInteger(raw.pdfPage)
				? { pdfPage: Number(raw.pdfPage) }
				: {}),
		...(typeof raw.section === "string" ? { section: raw.section } : {}),
		...(typeof raw.object === "string" ? { object: raw.object } : {}),
		...(Number.isInteger(raw.note_revision)
			? { noteRevision: Number(raw.note_revision) }
			: Number.isInteger(raw.noteRevision)
				? { noteRevision: Number(raw.noteRevision) }
				: {}),
		...(typeof raw.note_hash === "string"
			? { noteHash: raw.note_hash }
			: typeof raw.noteHash === "string"
				? { noteHash: raw.noteHash }
				: {}),
		...(typeof raw.url === "string" ? { url: raw.url } : {}),
		...(typeof raw.commit === "string" ? { commit: raw.commit } : {}),
		...(typeof raw.path === "string" ? { path: raw.path } : {}),
		...(Number.isInteger(raw.line) ? { line: Number(raw.line) } : {}),
	};
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalJson(child)]),
		);
	}
	return value;
}

function normalizedPreviewLabel(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
