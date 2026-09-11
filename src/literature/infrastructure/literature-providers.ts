import type { LiteratureProvider, PaperRecord, ProviderPage } from "../domain/literature-types.ts";
import { searchArxivPage } from "./provider-arxiv.ts";
import {
	ACL_ANTHOLOGY_VENUES,
	aclAnthologyConstraintError,
	searchAclAnthologyPage,
} from "./provider-acl-anthology.ts";
import { searchCorePage, searchDblpPage } from "./provider-bibliography.ts";
import {
	LiteratureProviderHttpError,
	type ProviderCredentials,
	type ProviderSearchOptions,
	setProviderCredentials,
} from "./provider-common.ts";
import { searchCrossrefByDoi, searchCrossrefPage } from "./provider-crossref.ts";
import { searchOpenCitationsPage, searchUnpaywallPage } from "./provider-doi-enrichment.ts";
import { searchExaPage } from "./provider-exa.ts";
import { searchOpenAlexByDoi, searchOpenAlexPage } from "./provider-openalex.ts";
import { searchSemanticScholarByDoi, searchSemanticScholarPage } from "./provider-semantic-scholar.ts";
import { searchUsenixPage } from "./provider-usenix.ts";

export { LiteratureProviderHttpError, setProviderCredentials };
export type { ProviderCredentials, ProviderSearchOptions };
export { searchArxivPage } from "./provider-arxiv.ts";
export {
	ACL_ANTHOLOGY_VENUES,
	aclAnthologyConstraintError,
	aclAnthologyFiltersForRecord,
	searchAclAnthologyPage,
} from "./provider-acl-anthology.ts";
export { searchCorePage, searchDblpPage } from "./provider-bibliography.ts";
export { searchCrossrefByDoi, searchCrossrefPage } from "./provider-crossref.ts";
export { searchOpenCitationsPage, searchUnpaywallPage } from "./provider-doi-enrichment.ts";
export { searchExaPage } from "./provider-exa.ts";
export { searchUsenixPage } from "./provider-usenix.ts";
export {
	fetchOpenAlexWorks,
	searchOpenAlexByDoi,
	searchOpenAlexCitations,
	searchOpenAlexPage,
} from "./provider-openalex.ts";
export {
	searchSemanticScholarByDoi,
	searchSemanticScholarCitations,
	searchSemanticScholarPage,
} from "./provider-semantic-scholar.ts";

export type LiteratureProviderCapability =
	| "keyword-search"
	| "doi-enrichment"
	| "citation-enrichment"
	| "open-access"
	| "preprint-discovery";

export type ProviderDoiLookupOptions = Omit<ProviderSearchOptions, "query" | "limit" | "cursor" | "filters">;

export interface LiteratureProviderSearchConstraints {
	exactYear?: boolean;
	singleVenue?: boolean;
	supportedVenues?: readonly string[];
}

export interface LiteratureProviderDefinition {
	id: LiteratureProvider;
	label: string;
	description: string;
	capabilities: readonly LiteratureProviderCapability[];
	requiresEnvironmentVariable?: string;
	searchConstraints?: LiteratureProviderSearchConstraints;
	search(options: ProviderSearchOptions): Promise<ProviderPage>;
	lookupByDoi?: (doi: string, options: ProviderDoiLookupOptions) => Promise<PaperRecord | undefined>;
}

export const literatureProviderDefinitions: readonly LiteratureProviderDefinition[] = [
	{
		id: "arxiv",
		label: "arXiv",
		description: "Open preprints and public PDFs",
		capabilities: ["keyword-search", "preprint-discovery"],
		search: searchArxivPage,
	},
	{
		id: "acl_anthology",
		label: "ACL Anthology",
		description: "Official ACL-family proceedings for one exact year and venue",
		capabilities: ["keyword-search", "open-access"],
		searchConstraints: {
			exactYear: true,
			singleVenue: true,
			supportedVenues: ACL_ANTHOLOGY_VENUES,
		},
		search: searchAclAnthologyPage,
	},
	{
		id: "openalex",
		label: "OpenAlex",
		description: "Broad scholarly graph and citations",
		capabilities: ["keyword-search", "doi-enrichment", "citation-enrichment", "open-access"],
		search: searchOpenAlexPage,
		lookupByDoi: (doi, options) => searchOpenAlexByDoi(doi, { ...options, queryLabel: doi }),
	},
	{
		id: "crossref",
		label: "Crossref",
		description: "DOI registration metadata",
		capabilities: ["keyword-search", "doi-enrichment"],
		search: searchCrossrefPage,
		lookupByDoi: searchCrossrefByDoi,
	},
	{
		id: "semanticscholar",
		label: "Semantic Scholar",
		description: "Scholarly search and citation graph",
		capabilities: ["keyword-search", "doi-enrichment", "citation-enrichment", "open-access", "preprint-discovery"],
		search: searchSemanticScholarPage,
		lookupByDoi: searchSemanticScholarByDoi,
	},
	{
		id: "dblp",
		label: "DBLP",
		description: "Computer science bibliography",
		capabilities: ["keyword-search"],
		search: searchDblpPage,
	},
	{
		id: "core",
		label: "CORE",
		description: "Open-access aggregator",
		capabilities: ["keyword-search", "open-access"],
		requiresEnvironmentVariable: "CORE_API_KEY",
		search: searchCorePage,
	},
	{
		id: "opencitations",
		label: "OpenCitations",
		description: "DOI metadata and citation enrichment",
		capabilities: ["doi-enrichment", "citation-enrichment"],
		search: searchOpenCitationsPage,
		lookupByDoi: async (doi, options) =>
			(await searchOpenCitationsPage({ ...options, query: doi, limit: 1 })).records[0],
	},
	{
		id: "unpaywall",
		label: "Unpaywall",
		description: "Open-access locations by DOI",
		capabilities: ["doi-enrichment", "open-access"],
		requiresEnvironmentVariable: "UNPAYWALL_EMAIL",
		search: searchUnpaywallPage,
		lookupByDoi: async (doi, options) => (await searchUnpaywallPage({ ...options, query: doi, limit: 1 })).records[0],
	},
	{
		id: "exa",
		label: "Exa",
		description: "Neural web and academic search via Exa MCP (no API key)",
		capabilities: ["keyword-search"],
		search: searchExaPage,
	},
	{
		id: "usenix",
		label: "USENIX",
		description: "Official USENIX conference papers and open-access PDFs",
		capabilities: ["keyword-search", "open-access"],
		search: searchUsenixPage,
	},
] as const;

const registry = new Map(literatureProviderDefinitions.map((definition) => [definition.id, definition]));

export function providersWithCapability(capability: LiteratureProviderCapability): LiteratureProvider[] {
	return literatureProviderDefinitions
		.filter((definition) => definition.capabilities.includes(capability))
		.map((definition) => definition.id);
}

export function assertKeywordSearchProviders(providers: string[]): LiteratureProvider[] {
	const searchable = new Set(providersWithCapability("keyword-search"));
	const invalid = providers.filter((provider) => !searchable.has(provider as LiteratureProvider));
	if (invalid.length) {
		throw new Error(`Providers do not support keyword search: ${invalid.join(", ")}`);
	}
	return [...new Set(providers)] as LiteratureProvider[];
}

export function searchProviderPage(
	provider: LiteratureProvider,
	options: ProviderSearchOptions,
): Promise<ProviderPage> {
	const definition = registry.get(provider);
	if (!definition) throw new Error(`Unknown literature provider: ${provider}`);
	if (!definition.capabilities.includes("keyword-search")) {
		throw new Error(`${definition.label} does not support keyword search; use DOI enrichment after discovery`);
	}
	if (provider === "acl_anthology") {
		const problem = aclAnthologyConstraintError(options.filters);
		if (problem) throw new Error(problem);
	}
	return definition.search(options);
}

export async function enrichProviderByDoi(
	provider: LiteratureProvider,
	doi: string,
	options: ProviderDoiLookupOptions = {},
): Promise<PaperRecord | undefined> {
	const definition = registry.get(provider);
	if (!definition) throw new Error(`Unknown literature provider: ${provider}`);
	if (!definition.capabilities.includes("doi-enrichment") || !definition.lookupByDoi) {
		throw new Error(`${definition.label} does not support DOI enrichment`);
	}
	return definition.lookupByDoi(doi, options);
}
