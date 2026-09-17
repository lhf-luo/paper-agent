import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { normalizeTitle } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import {
	compactSidebarRows,
	MAX_SIDEBAR_BYTES,
	parseSidebarResultMetadata,
	resolveSidebarResultPath,
	SIDEBAR_META_COMMENT,
} from "./literature-sidebar.ts";
import {
	renderSidebarTable,
	type SidebarField,
	sidebarMetadataFromRecord,
	validateSidebarFields,
} from "./literature-sidebar-fields.ts";
import type { LiteratureStore } from "./literature-store.ts";

export interface SidebarRowSelector {
	targetPaperId?: string;
	targetSearchRunId?: string;
	targetTitle?: string;
}

export type SidebarEditOperation =
	| { action: "set-fields"; fields: SidebarField[] }
	| ({ action: "replace-from-search"; searchRunId: string; paperId: string } & SidebarRowSelector)
	| {
			action: "add-from-search";
			searchRunId: string;
			paperId: string;
			focus?: string;
			relevance?: string;
			topic?: string;
	  }
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
	addedPaperIds: string[];
	removedPaperIds: string[];
	updatedPaperIds: string[];
	warnings: string[];
}

interface SidebarDocumentRow {
	meta: Record<string, unknown>;
}

interface ParsedSidebarDocument {
	prefixLines: string[];
	suffixLines: string[];
	fields: SidebarField[];
	rows: SidebarDocumentRow[];
	revision: number;
}

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
	if (!metadata.fields) {
		throw new Error("This literature sidebar uses the unsupported legacy column format");
	}
	const fields = validateSidebarFields(metadata.fields);
	const bodyLines = trimmed.slice(0, metadataMatch.index).trimEnd().split(/\r?\n/);
	let headerIndex = -1;
	for (let index = 0; index < bodyLines.length - 1; index += 1) {
		if (isTableRow(bodyLines[index]) && isSeparatorRow(bodyLines[index + 1])) {
			headerIndex = index;
			break;
		}
	}
	if (headerIndex < 0) throw new Error("Literature sidebar result does not contain a markdown table");
	const headers = splitTableRow(bodyLines[headerIndex]);
	if (headers.length !== fields.length || headers.some((header, index) => header !== fields[index])) {
		throw new Error("Literature sidebar columns do not match the stored fields schema");
	}
	let rowEnd = headerIndex + 2;
	while (rowEnd < bodyLines.length && isTableRow(bodyLines[rowEnd])) rowEnd += 1;
	const cells = bodyLines.slice(headerIndex + 2, rowEnd).map(splitTableRow);
	if (cells.some((row) => row.length !== fields.length)) {
		throw new Error("Literature sidebar table contains a row with the wrong number of columns");
	}
	const metaRows = metadata.rows ?? [];
	if (cells.length !== metaRows.length) {
		throw new Error(
			`Sidebar row metadata is misaligned (${cells.length} table rows, ${metaRows.length} metadata rows)`,
		);
	}
	return {
		prefixLines: bodyLines.slice(0, headerIndex),
		suffixLines: bodyLines.slice(rowEnd),
		fields,
		rows: metaRows.map((meta) => ({ meta: { ...meta } })),
		revision: Number.isInteger(metadata.revision) && Number(metadata.revision) > 0 ? Number(metadata.revision) : 1,
	};
}

async function searchRecord(
	store: LiteratureStore,
	searchRunId: string,
	paperId: string,
): Promise<{ record: PaperRecord; namespace: string }> {
	const run = await store.getSearchRun(searchRunId);
	if (!run) throw new Error(`Search run not found: ${searchRunId}`);
	const record = run.results.find((candidate) => candidate.id === paperId);
	if (!record) throw new Error(`Paper ${paperId} was not found in search run ${searchRunId}`);
	return { record, namespace: run.namespace };
}

function selectRow(rows: SidebarDocumentRow[], selector: SidebarRowSelector): number {
	if (selector.targetSearchRunId && !selector.targetPaperId) {
		throw new Error("target_search_run_id requires target_paper_id");
	}
	let matches: number[] = [];
	if (selector.targetPaperId) {
		matches = rows.flatMap((row, index) =>
			row.meta.paper_id === selector.targetPaperId &&
			(!selector.targetSearchRunId || row.meta.search_run_id === selector.targetSearchRunId)
				? [index]
				: [],
		);
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
		if (arxivId && typeof row.meta.arxiv_id === "string" && row.meta.arxiv_id.trim().toLowerCase() === arxivId)
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
	if (operation.action === "set-fields") {
		const fields = validateSidebarFields(operation.fields);
		if (
			fields.length === document.fields.length &&
			fields.every((field, index) => field === document.fields[index])
		) {
			return false;
		}
		document.fields = fields;
		return true;
	}
	if (operation.action === "remove") {
		document.rows.splice(selectRow(document.rows, operation), 1);
		return true;
	}
	if (operation.action === "patch") {
		if (operation.focus === undefined && operation.relevance === undefined && operation.topic === undefined) {
			throw new Error("Patch operation must change focus, relevance, or topic");
		}
		const row = document.rows[selectRow(document.rows, operation)];
		for (const field of ["focus", "relevance", "topic"] as const) {
			if (operation[field] === undefined) continue;
			const value = operation[field]?.trim();
			if (value) row.meta[field] = value;
			else delete row.meta[field];
		}
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
		document.rows.push({ meta });
		return true;
	}
	const found = await searchRecord(store, operation.searchRunId, operation.paperId);
	if (operation.action === "add-from-search") {
		const meta = sidebarMetadataFromRecord(found.record, {
			searchRunId: operation.searchRunId,
			namespace: found.namespace,
			preserved: {
				...(operation.focus?.trim() ? { focus: operation.focus.trim() } : {}),
				...(operation.relevance?.trim() ? { relevance: operation.relevance.trim() } : {}),
				...(operation.topic?.trim() ? { topic: operation.topic.trim() } : {}),
			},
		});
		if (duplicateIndex(document.rows, meta) >= 0) {
			warnings.push(`Skipped duplicate search result: ${found.record.title}`);
			return false;
		}
		document.rows.push({ meta });
		return true;
	}
	const index = selectRow(document.rows, operation);
	const previous = document.rows[index];
	const preserved = Object.fromEntries(
		["focus", "relevance", "topic", "screening_status"].flatMap((field) =>
			previous.meta[field] === undefined ? [] : [[field, previous.meta[field]]],
		),
	);
	const meta = sidebarMetadataFromRecord(found.record, {
		searchRunId: operation.searchRunId,
		namespace: found.namespace,
		preserved,
	});
	if (duplicateIndex(document.rows, meta, index) >= 0) {
		throw new Error(`Replacement would duplicate another sidebar row: ${found.record.title}`);
	}
	document.rows[index] = { meta };
	return true;
}

function renderDocument(document: ParsedSidebarDocument, revision: number): string {
	const table = renderSidebarTable(
		document.fields,
		document.rows.map((row) => row.meta),
	);
	const body = [...document.prefixLines, table, ...document.suffixLines].join("\n").trimEnd();
	const metadata = {
		revision,
		fields: document.fields,
		rows: compactSidebarRows(document.rows.map((row) => row.meta)),
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
	const before = new Map(
		document.rows.flatMap((row) =>
			typeof row.meta.paper_id === "string" ? [[row.meta.paper_id, JSON.stringify(row.meta)] as const] : [],
		),
	);
	const warnings: string[] = [];
	let changed = 0;
	for (const operation of operations) {
		if (await applyOperation(document, operation, store, warnings)) changed += 1;
	}
	if (changed === 0) {
		return {
			resultUrl,
			revision: document.revision,
			rowCount: document.rows.length,
			changed,
			addedPaperIds: [],
			removedPaperIds: [],
			updatedPaperIds: [],
			warnings,
		};
	}
	const after = new Map(
		document.rows.flatMap((row) =>
			typeof row.meta.paper_id === "string" ? [[row.meta.paper_id, JSON.stringify(row.meta)] as const] : [],
		),
	);
	const addedPaperIds = [...after.keys()].filter((id) => !before.has(id));
	const removedPaperIds = [...before.keys()].filter((id) => !after.has(id));
	const updatedPaperIds = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
	const revision = document.revision + 1;
	const content = renderDocument(document, revision);
	if (Buffer.byteLength(content, "utf8") > MAX_SIDEBAR_BYTES) {
		throw new Error("Edited literature sidebar result is too large (max 5MB)");
	}
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return {
		resultUrl,
		revision,
		rowCount: document.rows.length,
		changed,
		addedPaperIds,
		removedPaperIds,
		updatedPaperIds,
		warnings,
	};
}
