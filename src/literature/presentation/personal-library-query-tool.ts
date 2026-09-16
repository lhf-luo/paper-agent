import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { type PersonalPaperDetails, queryPersonalLibraryPaper } from "../application/personal-paper-query.ts";
import { paperPrimaryUrl } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";

function values(values: Array<string | undefined>): string {
	return values.filter((value): value is string => Boolean(value)).join(", ") || "none";
}

function candidateLine(record: PaperRecord): string {
	return `- ${record.title} | paper_id=${record.id} | DOI=${record.identifiers.doi ?? "none"} | authors=${values(record.authors)}`;
}

function formatPaperDetails(details: PersonalPaperDetails): string {
	const record = details.record;
	const lines = [
		"Personal library paper:",
		`Title: ${record.title}`,
		`Paper ID: ${record.id}`,
		`Authors: ${values(record.authors)}`,
		`Year / venue: ${record.year ?? "unknown"} / ${record.venue ?? "unknown"}`,
		`Publication type / venue rank: ${record.publicationType ?? "unknown"} / ${record.venueRank ?? "none"}`,
		`DOI: ${record.identifiers.doi ?? "none"}`,
		`arXiv: ${record.identifiers.arxivId ?? "none"}`,
		`Other identifiers: ${values([
			record.identifiers.openAlexId,
			record.identifiers.semanticScholarId,
			record.identifiers.dblpKey,
			record.identifiers.coreId,
			record.identifiers.openCitationsId,
		])}`,
		`Primary URL: ${paperPrimaryUrl(record) ?? "none"}`,
		`Collections: ${details.collections.map((collection) => collection.path.join(" / ")).join("; ") || "uncategorized"}`,
		`Tags: ${values(record.curation?.tags ?? [])}`,
		`Screening: ${record.curation?.screening?.status ?? "unreviewed"}`,
		`Reading: ${record.curation?.reading?.status ?? "unread"}`,
		`Remote PDF download links: ${details.remotePdfLinks.length}`,
		...details.remotePdfLinks.map(
			(link, index) => `  ${index + 1}. ${link.url}${link.openAccess === true ? " (open access)" : ""}`,
		),
		`Publication versions: ${details.publicationVersions.length}`,
		...details.publicationVersions.map(
			(version, index) =>
				`  ${index + 1}. ${version.kind}; publication_version_id=${version.id}; preferred=${version.isPreferred}`,
		),
		`Local PDF versions: ${details.localPdfVersions.length}`,
		...details.localPdfVersions.map(
			(version, index) =>
				`  ${index + 1}. ${version.versionKind ?? "unknown"}; ${version.blobPath}; source=${version.sourceUrl}; sha256=${version.sha256}`,
		),
		`Artifact links: ${details.artifacts.links.length}`,
		...details.artifacts.links.map((link, index) => `  ${index + 1}. ${link.url}`),
		`Acquired Artifacts: ${details.artifacts.latestAcquisitions.length}`,
		...details.artifacts.latestAcquisitions.map(
			(snapshot, index) =>
				`  ${index + 1}. ${snapshot.status}; ${snapshot.localPath ?? snapshot.finalUrl ?? snapshot.sourceUrl}`,
		),
		`Notes: ${record.curation?.userNotes.length ?? 0}`,
		...(record.curation?.userNotes ?? []).map((note, index) => `  ${index + 1}. ${note.text}`),
		`Derived records: ${details.derivedRecords.length}`,
		"Abstract:",
		record.abstract ?? "unavailable",
		"",
		"All stored links:",
		...(record.links.length
			? record.links.map(
					(link, index) =>
						`${index + 1}. [${link.kind}] ${link.url}${link.openAccess === true ? " (open access)" : ""}`,
				)
			: ["none"]),
	];
	return lines.join("\n");
}

export function registerPersonalLibraryQueryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "get_personal_library_paper",
		label: "Get personal library paper",
		description:
			"Read one paper's complete stored personal-library record by exact title, paper ID, DOI, or arXiv ID. Returns metadata, abstract, publication version IDs, remote PDF links, local PDF versions and paths, collections, notes, provenance, derived records, and acquired Artifacts. Makes no external requests and performs no writes.",
		promptSnippet: "Inspect one complete personal-library paper record and its saved materials",
		promptGuidelines: [
			"Use this instead of a new provider search when the user asks about a paper already saved in the personal library.",
			"Pass the exact title when paper_id is unknown. If multiple or only approximate candidates are returned, ask the user or retry with the candidate paper_id; never guess.",
			"Distinguish remote PDF download links from localPdfVersions. A remote link is not proof that a PDF has already been saved.",
		],
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				description: "Exact paper title, Paper Agent paper_id, DOI, DOI URL, arXiv ID, or arXiv URL",
			}),
			namespace: Type.Optional(Type.String({ description: "Personal-library namespace; default: default" })),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "personal", namespace, params.corpus_root),
				"personal",
				namespace,
			);
			const result = await queryPersonalLibraryPaper(store, params.query);
			if (result.status === "found") {
				return {
					content: [{ type: "text", text: formatPaperDetails(result.paper) }],
					details: result,
				};
			}
			const heading =
				result.status === "ambiguous" ? "Multiple exact matches were found." : "No exact match was found.";
			const text = [
				heading,
				result.candidates.length
					? "Candidates (retry with paper_id after choosing the correct paper):"
					: "No approximate candidates were found in this namespace.",
				...result.candidates.map(candidateLine),
			].join("\n");
			return { content: [{ type: "text", text }], details: result };
		},
	});
}
