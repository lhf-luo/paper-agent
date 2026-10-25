import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAuthorPapersTool } from "./author-papers-tool.ts";
import { registerBrowserLiteratureTool } from "./browser-literature-tool.ts";
import { registerCitationExpansionTool } from "./citation-expansion-tool.ts";
import { registerCollectionQueryTools } from "./collection-query-tools.ts";
import { registerCollectionSearchTools } from "./collection-search-tools.ts";
import { registerLiteratureCollectionsTool } from "./literature-collections-tool.ts";
import { registerLiteratureCorpusTool } from "./literature-corpus-tool.ts";
import { registerLiteratureDownloadMemoryTools } from "./literature-download-memory-tools.ts";
import { registerPersonalLibraryQueryTool } from "./personal-library-query-tool.ts";
import { registerPersonalPaperDetailFieldsTool } from "./personal-paper-detail-fields-tool.ts";

export {
	type CollectionResult,
	type CollectLiteratureOptions,
	collectionPersistencePlan,
	collectLiterature,
} from "../application/literature-collection.ts";
export {
	type FilteredRecord,
	type FilterGroupOptions,
	filterGroup,
	filterSearchRunResults,
} from "../application/literature-filtering.ts";
export {
	buildCandidatePaperTable,
	expandLiteratureQueries,
	tagCitationExpansionRecords,
} from "../application/literature-query-planning.ts";
export {
	buildCitationExpansionTable,
	planLiteratureSearch,
	saveSearchRunSelection,
	searchRunSelectionPlan,
} from "../application/literature-search-planning.ts";
export function registerCollectionTools(pi: ExtensionAPI): void {
	registerCollectionSearchTools(pi);
	registerCollectionQueryTools(pi);
	registerPersonalLibraryQueryTool(pi);
	registerPersonalPaperDetailFieldsTool(pi);
	registerCitationExpansionTool(pi);
	registerAuthorPapersTool(pi);
	registerBrowserLiteratureTool(pi);
	registerLiteratureDownloadMemoryTools(pi);
	registerLiteratureCollectionsTool(pi);
	registerLiteratureCorpusTool(pi);
}
