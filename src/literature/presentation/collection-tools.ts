import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCitationExpansionTool } from "./citation-expansion-tool.ts";
import { registerCollectionQueryTools } from "./collection-query-tools.ts";
import { registerCollectionSearchTools } from "./collection-search-tools.ts";
import { registerLiteratureCollectionsTool } from "./literature-collections-tool.ts";
import { registerLiteratureCorpusTool } from "./literature-corpus-tool.ts";
import { registerLiteratureDownloadMemoryTools } from "./literature-download-memory-tools.ts";
import { registerPersonalLibraryQueryTool } from "./personal-library-query-tool.ts";

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
export { enrichSidebarRows, mergeSidebarRows, scrapeRowsFromMarkdown } from "../application/literature-sidebar.ts";

export function registerCollectionTools(pi: ExtensionAPI): void {
	registerCollectionSearchTools(pi);
	registerCollectionQueryTools(pi);
	registerPersonalLibraryQueryTool(pi);
	registerCitationExpansionTool(pi);
	registerLiteratureDownloadMemoryTools(pi);
	registerLiteratureCollectionsTool(pi);
	registerLiteratureCorpusTool(pi);
}
