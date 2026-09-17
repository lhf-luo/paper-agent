import { Type } from "typebox";
import type { PersonalPaperDetails } from "../application/personal-paper-query.ts";
import type { PaperRecord } from "../domain/literature-types.ts";

export const paperProjectionFieldSchema = Type.Union([
	Type.Literal("title"),
	Type.Literal("abstract"),
	Type.Literal("authors"),
	Type.Literal("year"),
	Type.Literal("venue"),
	Type.Literal("venue_rank"),
	Type.Literal("publication_type"),
	Type.Literal("identifiers"),
	Type.Literal("links"),
	Type.Literal("material_hashes"),
	Type.Literal("citation_count"),
	Type.Literal("referenced_works"),
	Type.Literal("cited_by_api_url"),
	Type.Literal("provenance"),
	Type.Literal("discovery_paths"),
	Type.Literal("merged_from"),
	Type.Literal("tags"),
	Type.Literal("notes"),
	Type.Literal("screening"),
	Type.Literal("reading"),
	Type.Literal("team_review"),
	Type.Literal("collection_ids"),
]);

export const personalPaperProjectionFieldSchema = Type.Union([
	paperProjectionFieldSchema,
	Type.Literal("collections"),
	Type.Literal("remote_pdf_links"),
	Type.Literal("publication_versions"),
	Type.Literal("local_pdf_versions"),
	Type.Literal("artifacts"),
	Type.Literal("derived_records"),
]);

export type PaperProjectionField =
	| "title"
	| "abstract"
	| "authors"
	| "year"
	| "venue"
	| "venue_rank"
	| "publication_type"
	| "identifiers"
	| "links"
	| "material_hashes"
	| "citation_count"
	| "referenced_works"
	| "cited_by_api_url"
	| "provenance"
	| "discovery_paths"
	| "merged_from"
	| "tags"
	| "notes"
	| "screening"
	| "reading"
	| "team_review"
	| "collection_ids";

export type PersonalPaperProjectionField =
	| PaperProjectionField
	| "collections"
	| "remote_pdf_links"
	| "publication_versions"
	| "local_pdf_versions"
	| "artifacts"
	| "derived_records";

export function projectPaperRecord(
	record: PaperRecord,
	fields: readonly PaperProjectionField[],
): Record<string, unknown> {
	const selected: Record<string, unknown> = { id: record.id };
	for (const field of new Set(fields)) {
		switch (field) {
			case "title":
			case "abstract":
			case "authors":
			case "year":
			case "venue":
				selected[field] = record[field];
				break;
			case "venue_rank":
				selected.venueRank = record.venueRank;
				break;
			case "publication_type":
				selected.publicationType = record.publicationType;
				break;
			case "identifiers":
				selected.identifiers = record.identifiers;
				break;
			case "links":
				selected.links = record.links;
				break;
			case "material_hashes":
				selected.materialHashes = record.materialHashes;
				break;
			case "citation_count":
				selected.citationCount = record.citationCount;
				break;
			case "referenced_works":
				selected.referencedWorks = record.referencedWorks;
				break;
			case "cited_by_api_url":
				selected.citedByApiUrl = record.citedByApiUrl;
				break;
			case "provenance":
				selected.provenance = record.provenance;
				break;
			case "discovery_paths":
				selected.discoveryPaths = record.discoveryPaths;
				break;
			case "merged_from":
				selected.mergedFrom = record.mergedFrom;
				break;
			case "tags":
				selected.tags = record.curation?.tags;
				break;
			case "notes":
				selected.notes = record.curation?.userNotes;
				break;
			case "screening":
				selected.screening = record.curation?.screening;
				break;
			case "reading":
				selected.reading = record.curation?.reading;
				break;
			case "team_review":
				selected.teamReview = record.curation?.teamReview;
				break;
			case "collection_ids":
				selected.collectionIds = record.collectionIds;
				break;
		}
	}
	return selected;
}

export function projectPersonalPaperDetails(
	details: PersonalPaperDetails,
	fields: readonly PersonalPaperProjectionField[],
): Record<string, unknown> {
	const recordFields = fields.filter(
		(field): field is PaperProjectionField =>
			![
				"collections",
				"remote_pdf_links",
				"publication_versions",
				"local_pdf_versions",
				"artifacts",
				"derived_records",
			].includes(field),
	);
	const selected = projectPaperRecord(details.record, recordFields);
	for (const field of new Set(fields)) {
		switch (field) {
			case "collections":
				selected.collections = details.collections;
				break;
			case "remote_pdf_links":
				selected.remotePdfLinks = details.remotePdfLinks;
				break;
			case "publication_versions":
				selected.publicationVersions = details.publicationVersions;
				break;
			case "local_pdf_versions":
				selected.localPdfVersions = details.localPdfVersions;
				break;
			case "artifacts":
				selected.artifacts = details.artifacts;
				break;
			case "derived_records":
				selected.derivedRecords = details.derivedRecords;
				break;
		}
	}
	return selected;
}

export function projectCandidate(record: PaperRecord): Pick<PaperRecord, "id" | "title"> {
	return { id: record.id, title: record.title };
}
