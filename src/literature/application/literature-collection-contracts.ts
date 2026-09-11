import type { OperationAuthorization } from "../../shared/application/operation-consent.ts";
import type {
	CorpusScope,
	LiteratureProvider,
	LiteratureSearchPlan,
	PersistenceMode,
	SearchFilters,
	SearchRun,
} from "../domain/literature-types.ts";
import type { searchProviderPage } from "../infrastructure/literature-providers.ts";

export interface CollectLiteratureOptions {
	queries: string[];
	providers: LiteratureProvider[];
	filters: SearchFilters;
	pagesPerProvider: number;
	maxResultsPerProvider: number;
	scope: CorpusScope;
	mode: PersistenceMode;
	namespace: string;
	cwd: string;
	corpusRoot?: string;
	refreshCache?: boolean;
	reuseCorpus?: boolean;
	corpusOnly?: boolean;
	signal?: AbortSignal;
	authorization?: OperationAuthorization;
	checkpointPath?: string;
	providerPageSearch?: typeof searchProviderPage;
	searchPlan?: LiteratureSearchPlan;
}

export interface CollectionResult {
	run: SearchRun;
	cached: boolean;
	corpusPath?: string;
	persistenceCounts?: { created: number; updated: number; unchanged: number };
}
