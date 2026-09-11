import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { paperPrimaryUrl, normalizeTitle } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import { lookupCcfLevel } from "../infrastructure/ccf-ranking.ts";
import {
	parseSidebarResultMetadata,
	resolveSidebarResultPath,
	SIDEBAR_META_COMMENT,
} from "./literature-sidebar.ts";
import type { LiteratureStore } from "./literature-store.ts";

export interface SidebarRowSelector {
	targetPaperId?: string;
	targetTitle?: string;
}

export type SidebarEditOperation =
	| ({ action: "replace-from-search"; searchRunId: string; paperId: string } & SidebarRowSelector)
	| { action: "add-from-search"; searchRunId: string; paperId: string; focus?: string; relevance?: string; topic?: string }
	| {
			action: "add-model-supplement";
			title: string;
			authors?: string;
			year?: string;
			venue?: string;
			url?: string;
			focus?: string;
			relevance?: string;
			topic?: string;
		}
	| ({ action: "remove" } & SidebarRowSelector)
	| ({ action: "patch"; focus?: string; relevance?: string; topic?: string } & SidebarRowSelector);

export interface SidebarEditResult {
	resultUrl: string;
	revision: number;
	rowCount: number;
	changed: number;
	warnings: string[];
}

interface SidebarDocumentRow {
	cells: string[];
	meta: Record<string, unknown>;
}

interface ParsedSidebarDocument {
	prefixLines: string[];
	suffixLines: string[];
	headers: string[];
	metadataHeaders?: string[];
	rows: SidebarDocumentRow[];
	revision: number;
}

const MAX_SIDEBAR_BYTES = 200_000;

function splitTableRow(line: string): string[] {
	return line
		.trim()
		.slice(1, -1)
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isSeparatorRow(line: string): boolean {
	return isTableRow(line) && splitTableRow(line).every((cell) => /^:?-{2,}:?$/.test(cell));
}

function parseSidebarDocument(content: string): ParsedSidebarDocument {
	const trimmed = content.trimEnd();
	const metadataMatch = SIDEBAR_META_COMMENT.exec(trimmed);
	if (!metadataMatch || metadataMatch.index === undefined) {
		throw new Error("Literature sidebar result does not contain structured metadata");
	}
	const metadata = parseSidebarResultMetadata(trimmed);
	const bodyLines = trimmed.slice(0, metadataMatch.index).trimEnd().split(/\r?\n/);
	let headerIndex = -1;
	for (let index = 0; index < bodyLines.length - 1; index += 1) {
		if (isTableRow(bodyLines[index]) && isSeparatorRow(bodyLines[index + 1])) {
			headerIndex = index;
			break;
		}
	}
	if (headerIndex < 0) throw new Error("Literature sidebar result does not contain a markdown table");
	let rowEnd = headerIndex + 2;
	while (rowEnd < bodyLines.length && isTableRow(bodyLines[rowEnd])) rowEnd += 1;
	const cells = bodyLines.slice(headerIndex + 2, rowEnd).map(splitTableRow);
	const metaRows = metadata.rows ?? [];
	if (cells.length !== metaRows.length) {
		throw new Error(`Sidebar row metadata is misaligned (${cells.length} table rows, ${metaRows.length} metadata rows)`);
	}
	return {
		prefixLines: bodyLines.slice(0, headerIndex + 2),
		suffixLines: bodyLines.slice(rowEnd),
		headers: splitTableRow(bodyLines[headerIndex]),
		metadataHeaders: metadata.headers,
		rows: cells.map((rowCells, index) => ({ cells: rowCells, meta: { ...metaRows[index] } })),
		revision: Number.isInteger(metadata.revision) && Number(metadata.revision) > 0 ? Number(metadata.revision) : 1,
	};
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function titleCell(title: string, url?: string): string {
	const label = escapeCell(title).replace(/\[|\]/g, "\\$&");
	return url ? `[${label}](${url.replace(/\s/g, "%20")})` : label;
}

function columnIndex(headers: string[], pattern: RegExp, fallback: number): number {
	const found = headers.findIndex((header) => pattern.test(header.trim()));
	return found >= 0 ? found : Math.min(fallback, Math.max(0, headers.length - 1));
}

function sourceMeta(record: PaperRecord, searchRunId: string, preserved: Record<string, unknown> = {}) {
	const meta: Record<string, unknown> = {
		...preserved,
		title: record.title,
		paper_id: record.id,
		search_run_id: searchRunId,
		curated: "search",
		authors: record.authors.join(", "),
	};
	const url = paperPrimaryUrl(record);
	if (url) meta.url = url;
	if (record.abstract) meta.abstract = record.abstract;
	if (record.year !== undefined) meta.year = String(record.year);
	if (record.venue) meta.venue = record.venue;
	if (record.identifiers.doi) meta.doi = record.identifiers.doi;
	if (record.identifiers.arxivId) meta.arxiv_id = record.identifiers.arxivId;
	if (record.citationCount !== undefined) meta.citationCount = record.citationCount;
	const ccf = record.venueRank ?? lookupCcfLevel(record.venue);
	if (ccf) meta.ccf = ccf;
	return meta;
}

function cellsFromMeta(headers: string[], meta: Record<string, unknown>, previous?: string[]): string[] {
	const cells = previous ? [...previous] : Array.from({ length: Math.max(4, headers.length) }, () => "");
	while (cells.length < headers.length) cells.push("");
	const titleIndex = 0;
	const yearVenueIndex = columnIndex(headers, /year|年份/i, 1);
	const identifierIndex = columnIndex(headers, /identifier|标识|doi|arxiv/i, 2);
	const focusIndex = columnIndex(headers, /^focus$/i, 3);
	const title = typeof meta.title === "string" ? meta.title : "Untitled";
	const url = typeof meta.url === "string" ? meta.url : undefined;
	const year = typeof meta.year === "string" ? meta.year : "";
	const venue = typeof meta.venue === "string" ? meta.venue : "";
	const doi = typeof meta.doi === "string" ? meta.doi : undefined;
	const arxivId = typeof meta.arxiv_id === "string" ? meta.arxiv_id : undefined;
	cells[titleIndex] = titleCell(title, url);
	cells[yearVenueIndex] = escapeCell([year, venue].filter(Boolean).join(" "));
	cells[identifierIndex] = doi ? `DOI ${escapeCell(doi)}` : arxivId ? `arXiv ${escapeCell(arxivId)}` : "";
	cells[focusIndex] = typeof meta.focus === "string" ? escapeCell(meta.focus) : "";
	return cells;
}

async function searchRecord(store: LiteratureStore, searchRunId: string, paperId: string): Promise<PaperRecord> {
	const run = await store.getSearchRun(searchRunId);
	if (!run) throw new Error(`Search run not found: ${searchRunId}`);
	const record = run.results.find((candidate) => candidate.id === paperId);
	if (!record) throw new Error(`Paper ${paperId} was not found in search run ${searchRunId}`);
	return record;
}

function selectRow(rows: SidebarDocumentRow[], selector: SidebarRowSelector): number {
	let matches: number[] = [];
	if (selector.targetPaperId) {
		matches = rows.flatMap((row, index) => (row.meta.paper_id === selector.targetPaperId ? [index] : []));
	}
	if (matches.length === 0 && selector.targetTitle) {
		const title = normalizeTitle(selector.targetTitle);
		matches = rows.flatMap((row, index) =>
			typeof row.meta.title === "string" && normalizeTitle(row.meta.title) === title ? [index] : [],
		);
	}
	if (matches.length === 0) throw new Error("Target sidebar row was not found");
	if (matches.length > 1) throw new Error("Target sidebar row selector matched more than one row");
	return matches[0];
}

function duplicateIndex(rows: SidebarDocumentRow[], meta: Record<string, unknown>, ignoredIndex = -1): number {
	const title = typeof meta.title === "string" ? normalizeTitle(meta.title) : "";
	const doi = typeof meta.doi === "string" ? meta.doi.trim().toLowerCase() : "";
	const arxivId = typeof meta.arxiv_id === "string" ? meta.arxiv_id.trim().toLowerCase() : "";
	return rows.findIndex((row, index) => {
		if (index === ignoredIndex) return false;
		if (meta.paper_id && row.meta.paper_id === meta.paper_id) return true;
		if (doi && typeof row.meta.doi === "string" && row.meta.doi.trim().toLowerCase() === doi) return true;
		if (
			arxivId &&
			typeof row.meta.arxiv_id === "string" &&
			row.meta.arxiv_id.trim().toLowerCase() === arxivId
		)
			return true;
		return Boolean(title && typeof row.meta.title === "string" && normalizeTitle(row.meta.title) === title);
	});
}

async function applyOperation(
	document: ParsedSidebarDocument,
	operation: SidebarEditOperation,
	store: LiteratureStore,
	warnings: string[],
): Promise<boolean> {
	if (operation.action === "remove") {
		document.rows.splice(selectRow(document.rows, operation), 1);
		return true;
	}
	if (operation.action === "patch") {
		if (operation.focus === undefined && operation.relevance === undefined && operation.topic === undefined) {
			throw new Error("Patch operation must change focus, relevance, or topic");
		}
		const index = selectRow(document.rows, operation);
		const row = document.rows[index];
		for (const field of ["focus", "relevance", "topic"] as const) {
			if (operation[field] === undefined) continue;
			const value = operation[field]?.trim();
			if (value) row.meta[field] = value;
			else delete row.meta[field];
		}
		row.cells = cellsFromMeta(document.headers, row.meta, row.cells);
		return true;
	}
	if (operation.action === "add-model-supplement") {
		const meta: Record<string, unknown> = {
			title: operation.title.trim(),
			curated: "llm",
			...(operation.authors?.trim() ? { authors: operation.authors.trim() } : {}),
			...(operation.year?.trim() ? { year: operation.year.trim() } : {}),
			...(operation.venue?.trim() ? { venue: operation.venue.trim() } : {}),
			...(operation.url?.trim() ? { url: operation.url.trim() } : {}),
			...(operation.focus?.trim() ? { focus: operation.focus.trim() } : {}),
			...(operation.relevance?.trim() ? { relevance: operation.relevance.trim() } : {}),
			...(operation.topic?.trim() ? { topic: operation.topic.trim() } : {}),
		};
		if (!meta.title) throw new Error("Model supplement title is required");
		if (duplicateIndex(document.rows, meta) >= 0) {
			warnings.push(`Skipped duplicate model supplement: ${meta.title}`);
			return false;
		}
		document.rows.push({ meta, cells: cellsFromMeta(document.headers, meta) });
		return true;
	}
	const record = await searchRecord(store, operation.searchRunId, operation.paperId);
	if (operation.action === "add-from-search") {
		const meta = sourceMeta(record, operation.searchRunId, {
			...(operation.focus?.trim() ? { focus: operation.focus.trim() } : {}),
			...(operation.relevance?.trim() ? { relevance: operation.relevance.trim() } : {}),
			...(operation.topic?.trim() ? { topic: operation.topic.trim() } : {}),
		});
		if (duplicateIndex(document.rows, meta) >= 0) {
			warnings.push(`Skipped duplicate search result: ${record.title}`);
			return false;
		}
		document.rows.push({ meta, cells: cellsFromMeta(document.headers, meta) });
		return true;
	}
	const index = selectRow(document.rows, operation);
	const previous = document.rows[index];
	const preserved = Object.fromEntries(
		["focus", "relevance", "topic"].flatMap((field) =>
			previous.meta[field] === undefined ? [] : [[field, previous.meta[field]]],
		),
	);
	const meta = sourceMeta(record, operation.searchRunId, preserved);
	if (duplicateIndex(document.rows, meta, index) >= 0) {
		throw new Error(`Replacement would duplicate another sidebar row: ${record.title}`);
	}
	document.rows[index] = { meta, cells: cellsFromMeta(document.headers, meta, previous.cells) };
	return true;
}

function renderDocument(document: ParsedSidebarDocument, revision: number): string {
	const tableRows = document.rows.map((row) => `| ${row.cells.join(" | ")} |`);
	const body = [...document.prefixLines, ...tableRows, ...document.suffixLines].join("\n").trimEnd();
	const metadata = {
		revision,
		...(document.metadataHeaders ? { headers: document.metadataHeaders } : {}),
		rows: document.rows.map((row) => row.meta),
	};
	return `${body}\n\n<!-- paper-agent-sidebar-meta ${JSON.stringify(metadata)} -->\n`;
}

export async function editLiteratureSidebar(
	store: LiteratureStore,
	cwd: string,
	resultUrl: string,
	expectedRevision: number,
	operations: SidebarEditOperation[],
	sessionId?: string,
): Promise<SidebarEditResult> {
	if (!operations.length) throw new Error("At least one sidebar edit operation is required");
	const path = resolveSidebarResultPath(cwd, resultUrl);
	if (sessionId) {
		const safeSessionId = sessionId.replace(/[^A-Za-z0-9-]/g, "_");
		if (!basename(path).startsWith(`${safeSessionId}-`)) {
			throw new Error("The literature sidebar result does not belong to the current session");
		}
	}
	const document = parseSidebarDocument(await readFile(path, "utf8"));
	if (document.revision !== expectedRevision) {
		throw new Error(`Sidebar revision conflict: expected ${expectedRevision}, current ${document.revision}`);
	}
	const warnings: string[] = [];
	let changed = 0;
	for (const operation of operations) {
		if (await applyOperation(document, operation, store, warnings)) changed += 1;
	}
	if (changed === 0) {
		return { resultUrl, revision: document.revision, rowCount: document.rows.length, changed, warnings };
	}
	const revision = document.revision + 1;
	const content = renderDocument(document, revision);
	if (Buffer.byteLength(content, "utf8") > MAX_SIDEBAR_BYTES) {
		throw new Error("Edited literature sidebar result is too large (max 200KB)");
	}
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return { resultUrl, revision, rowCount: document.rows.length, changed, warnings };
}
