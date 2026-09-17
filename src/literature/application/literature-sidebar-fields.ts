import { paperPrimaryUrl } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import { lookupCcfLevel } from "../infrastructure/ccf-ranking.ts";
import { primaryIdentifier } from "./literature-query-planning.ts";
import { expansionPathRelationship } from "./literature-search-planning.ts";

export const SIDEBAR_FIELD_NAMES = [
	"title",
	"paper_id",
	"authors",
	"year",
	"venue",
	"year_venue",
	"publication_type",
	"identifier",
	"doi",
	"arxiv_id",
	"url",
	"citation_count",
	"ccf",
	"screening_status",
	"focus",
	"relevance",
	"topic",
] as const;

export const SIDEBAR_ANNOTATION_FIELD_NAMES = ["focus", "relevance", "topic"] as const;

export type SidebarField = (typeof SIDEBAR_FIELD_NAMES)[number];
export type SidebarAnnotationField = (typeof SIDEBAR_ANNOTATION_FIELD_NAMES)[number];

const SIDEBAR_FIELDS = new Set<string>(SIDEBAR_FIELD_NAMES);
const SIDEBAR_ANNOTATION_FIELDS = new Set<string>(SIDEBAR_ANNOTATION_FIELD_NAMES);

function clean(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function markdownLink(label: string, url: string): string {
	const safeLabel = escapeCell(label).replace(/[[\]]/g, "\\$&");
	const safeUrl = url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
	return `[${safeLabel}](${safeUrl})`;
}

export function validateSidebarFields(values: readonly string[]): SidebarField[] {
	if (values.length === 0) throw new Error("fields must contain at least title");
	if (values[0] !== "title") throw new Error("fields must start with title");
	const seen = new Set<string>();
	for (const value of values) {
		if (!SIDEBAR_FIELDS.has(value)) throw new Error(`Unsupported sidebar field: ${value}`);
		if (seen.has(value)) throw new Error(`Duplicate sidebar field: ${value}`);
		seen.add(value);
	}
	return [...values] as SidebarField[];
}

export function validateSidebarAnnotationFields(
	fields: readonly SidebarField[],
	values: readonly string[],
): SidebarAnnotationField[] {
	const visible = new Set<string>(fields);
	const seen = new Set<string>();
	for (const value of values) {
		if (!SIDEBAR_ANNOTATION_FIELDS.has(value)) throw new Error(`Unsupported annotation field: ${value}`);
		if (!visible.has(value)) throw new Error(`Annotation field is not visible: ${value}`);
		if (seen.has(value)) throw new Error(`Duplicate annotation field: ${value}`);
		seen.add(value);
	}
	for (const field of fields) {
		if (SIDEBAR_ANNOTATION_FIELDS.has(field) && !seen.has(field)) {
			throw new Error(`Visible Agent field must be declared in annotation_fields: ${field}`);
		}
	}
	return [...values] as SidebarAnnotationField[];
}

export function sidebarMetadataFromRecord(
	record: PaperRecord,
	input: {
		searchRunId: string;
		namespace: string;
		screeningStatus?: string;
		preserved?: Record<string, unknown>;
	},
): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		...(input.preserved ?? {}),
		title: record.title,
		paper_id: record.id,
		search_run_id: input.searchRunId,
		namespace: input.namespace,
		curated: "search",
		authors: record.authors.join(", "),
		identifier: primaryIdentifier(record),
	};
	if (input.screeningStatus) metadata.screening_status = input.screeningStatus;
	const url = paperPrimaryUrl(record);
	if (url) metadata.url = url;
	if (record.year !== undefined) metadata.year = String(record.year);
	if (record.venue) metadata.venue = record.venue;
	if (record.publicationType) metadata.publication_type = record.publicationType;
	if (record.identifiers.doi) metadata.doi = record.identifiers.doi;
	if (record.identifiers.arxivId) metadata.arxiv_id = record.identifiers.arxivId;
	if (record.citationCount !== undefined) metadata.citationCount = record.citationCount;
	const ccf = record.venueRank ?? lookupCcfLevel(record.venue);
	if (ccf) metadata.ccf = ccf;
	const relationshipPath = record.discoveryPaths?.find((path) => expansionPathRelationship(path));
	const relationship = relationshipPath ? expansionPathRelationship(relationshipPath) : undefined;
	if (relationship) metadata.relationship = relationship;
	return metadata;
}

function fieldValue(field: SidebarField, metadata: Record<string, unknown>): string {
	const value = (name: string) => clean(metadata[name]) ?? "";
	switch (field) {
		case "title": {
			const title = value("title") || "Untitled";
			const url = clean(metadata.url);
			return url ? markdownLink(title, url) : escapeCell(title);
		}
		case "year_venue":
			return escapeCell([value("year"), value("venue") || value("publication_type")].filter(Boolean).join(" / "));
		case "url": {
			const url = clean(metadata.url);
			return url ? markdownLink("Open", url) : "";
		}
		case "citation_count":
			return metadata.citationCount === undefined ? "" : escapeCell(String(metadata.citationCount));
		default:
			return escapeCell(value(field));
	}
}

export function renderSidebarTable(fields: readonly SidebarField[], rows: Array<Record<string, unknown>>): string {
	const header = `| ${fields.join(" | ")} |`;
	const separator = `| ${fields.map(() => "---").join(" | ")} |`;
	const body = rows.map((row) => `| ${fields.map((field) => fieldValue(field, row)).join(" | ")} |`);
	return [header, separator, ...body].join("\n");
}
