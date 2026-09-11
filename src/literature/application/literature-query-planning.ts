import type {
	CandidatePaperTableRow,
	LiteratureProvider,
	PaperDiscoveryPath,
	PaperRecord,
	ProvenanceProvider,
} from "../domain/literature-types.ts";

export function uniqueQueries(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim().replace(/\s+/g, " ");
		const key = normalized.toLowerCase();
		if (!normalized || seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	if (result.length === 0) throw new Error("At least one non-empty query is required");
	if (result.length > 12) throw new Error("At most 12 query variants are allowed per collection run");
	return result;
}

const queryEquivalences: Array<[string, string]> = [
	["artificial intelligence", "AI"],
	["machine learning", "ML"],
	["deep learning", "DL"],
	["large language model", "LLM"],
	["natural language processing", "NLP"],
	["reinforcement learning", "RL"],
	["retrieval augmented generation", "RAG"],
	["software engineering", "SE"],
	["internet of things", "IoT"],
];

export function expandLiteratureQueries(primary: string, explicit: string[] = []): string[] {
	const generated = [primary, ...explicit];
	const normalizedPrimary = primary.trim().replace(/\s+/g, " ");
	const dehyphenated = normalizedPrimary.replace(/(?<=\p{L})-(?=\p{L})/gu, " ");
	if (dehyphenated !== normalizedPrimary) generated.push(dehyphenated);
	for (const [phrase, acronym] of queryEquivalences) {
		const phrasePattern = new RegExp(`\\b${phrase.replaceAll(" ", "\\s+")}\\b`, "i");
		const acronymPattern = new RegExp(`\\b${acronym}\\b`, "i");
		if (phrasePattern.test(normalizedPrimary)) generated.push(normalizedPrimary.replace(phrasePattern, acronym));
		else if (acronymPattern.test(normalizedPrimary))
			generated.push(normalizedPrimary.replace(acronymPattern, phrase));
	}
	return uniqueQueries(generated).slice(0, 6);
}

function discoveryPathKey(path: PaperDiscoveryPath): string {
	return [
		path.kind,
		path.query ?? "",
		path.provider ?? "",
		path.seedPaperId ?? "",
		path.sourceUrl ?? "",
		path.note ?? "",
	]
		.join("|")
		.toLowerCase();
}

function addDiscoveryPath(record: PaperRecord, path: PaperDiscoveryPath): PaperRecord {
	const existing = record.discoveryPaths ?? [];
	if (existing.some((item) => discoveryPathKey(item) === discoveryPathKey(path))) return record;
	return { ...record, discoveryPaths: [...existing, path] };
}

export function withCorpusDiscoveryPath(record: PaperRecord, query: string, discoveredAt: string): PaperRecord {
	return addDiscoveryPath(record, { kind: "corpus-reuse", query, provider: "local-pdf", discoveredAt });
}

export function withProviderDiscoveryPath(
	record: PaperRecord,
	provider: LiteratureProvider,
	query: string,
	discoveredAt: string,
): PaperRecord {
	return addDiscoveryPath(record, { kind: "keyword-search", provider, query, discoveredAt });
}

export function tagCitationExpansionRecords(
	records: PaperRecord[],
	seed: PaperRecord,
	relationship: "reference" | "citation",
	provider: LiteratureProvider,
	depth: number,
	discoveredAt: string,
): PaperRecord[] {
	const kind = relationship === "reference" ? "reference-expansion" : "citation-expansion";
	return records.map((record) =>
		addDiscoveryPath(record, {
			kind,
			provider,
			query: `${relationship}s:${seed.id}`,
			seedPaperId: seed.id,
			note: `depth=${depth}`,
			discoveredAt,
		}),
	);
}

export function primaryIdentifier(record: PaperRecord): string {
	if (record.identifiers.doi) return `doi:${record.identifiers.doi}`;
	if (record.identifiers.arxivId) return `arXiv:${record.identifiers.arxivId}`;
	if (record.identifiers.openAlexId) return `OpenAlex:${record.identifiers.openAlexId}`;
	if (record.identifiers.semanticScholarId) return `S2:${record.identifiers.semanticScholarId}`;
	return "unavailable";
}

function discoveryPathLabel(path: PaperDiscoveryPath): string {
	return [
		path.kind,
		path.provider ? `provider=${path.provider}` : undefined,
		path.query ? `query=${path.query}` : undefined,
		path.seedPaperId ? `seed=${path.seedPaperId}` : undefined,
	]
		.filter(Boolean)
		.join(":");
}

function linkLabel(record: PaperRecord, kind: "pdf" | "artifact"): string {
	const link = record.links.find((item) => item.kind === kind);
	return link?.url ?? "not checked";
}

export function buildCandidatePaperTable(records: PaperRecord[]): CandidatePaperTableRow[] {
	return records.map((record) => {
		const providers = new Set<ProvenanceProvider>(record.provenance.map((item) => item.provider));
		const screening = record.curation?.screening;
		return {
			paperId: record.id,
			title: record.title,
			authors: record.authors.slice(0, 6).join(", ") || "unavailable",
			year: record.year === undefined ? "unknown" : String(record.year),
			venue: record.venue ?? "unknown",
			doiOrArxiv: primaryIdentifier(record),
			sources: [...providers].join(", ") || "unknown",
			discoveryPath: (record.discoveryPaths ?? []).map(discoveryPathLabel).join(" | ") || "unknown",
			screeningResult: screening
				? `${screening.status}${screening.reason ? `: ${screening.reason}` : ""}`
				: "unreviewed",
			pdf: linkLabel(record, "pdf"),
			code: linkLabel(record, "artifact"),
		};
	});
}
