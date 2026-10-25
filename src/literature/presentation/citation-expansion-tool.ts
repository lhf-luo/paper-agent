import { expandCitationNetwork } from "../application/literature-citation-expansion.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCitationExpansionTable } from "../application/literature-search-planning.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { formatCitationExpansionTable } from "./collection-tool-formatting.ts";
import { scopeSchema } from "./collection-tool-schemas.ts";

export function registerCitationExpansionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "expand_citation_network",
		label: "Expand citation network",
		description:
			"Expand references and/or citing works from personal-library seeds using OpenAlex and Semantic Scholar. Expansion is bounded, provenance-preserving, and deduplicated. Results include the original seeds first (outside neighbor and year limits), followed by deduplicated neighbors. Returns seedCount, neighborCount and total resultCount. Results are shown to the user but NOT automatically written to the corpus — the user decides later whether to save them.",
		promptSnippet: "Expand a paper's bounded citation neighborhood",
		promptGuidelines: [
			"Use citation expansion after a focused seed search, not as a substitute for a documented query strategy.",
			"Expansion results are staged in a saved Search Run and are not saved to the personal library automatically.",
			"In a canvas, display the Search Run with show_search_run_graph; filtering is optional. Outside a canvas, before creating a sidebar, screen the saved Search Run with filter_search_run_results, then pass its search_run_id and filter_result_id with fields, annotation_fields, and annotations to update_literature_sidebar.",
		],
		parameters: Type.Object({
			seed_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "Corpus paper ids" }),
			direction: Type.Optional(
				Type.Union([Type.Literal("references"), Type.Literal("citations"), Type.Literal("both")]),
			),
			depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			max_neighbors_per_seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			pages_per_seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
			max_total_neighbors: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
			source_search_run_id: Type.Optional(Type.String({ description: "Search run that supplied the seed papers" })),
			scope: Type.Optional(scopeSchema),

			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			if (scope === "team") {
				throw new Error(
					"Citation expansion cannot write directly to a team corpus; expand in personal scope, then promote",
				);
			}

			const store = new LiteratureStore(resolveCorpusRoot(ctx.cwd, scope, params.corpus_root), scope);
			const { run, missingSeedIds, seedCount, neighborCount } = await expandCitationNetwork(store, params, signal);
			const unique = run.results,
				seeds = run.seedSnapshots!,
				expansionRunId = run.id;
			const {
				direction,
				depth,
				pagesPerSeed,
				maxNeighborsPerSeed: limit,
				maxTotalNeighbors,
			} = run.citationExpansion!;
			const limitReached = run.citationExpansion!.limitReached;
			const failures = run.failures.map((f) => `${f.provider}/${f.query}: ${f.message}`);
			const expansionTable = buildCitationExpansionTable(unique, run.seedPaperIds);

			return {
				content: [
					{
						type: "text",
						text: [
							`Retained ${seeds.length} seeds and ${neighborCount} unique neighboring papers (${unique.length} total) (not saved to the corpus; staged in ${expansionRunId ?? "no saved run"}).`,
							`Direction/depth/pages: ${direction}/${depth}/${pagesPerSeed}`,
							`Neighbor budget: per-seed=${limit}; total=${maxTotalNeighbors}`,
							missingSeedIds.length
								? `Missing seed ids: ${missingSeedIds.join(", ")}`
								: "Missing seed ids: none",
							failures.length ? `Failures:\n- ${failures.join("\n- ")}` : "Failures: none",
							"",
							...formatCitationExpansionTable(expansionTable, 200),
						].join("\n"),
					},
				],
				details: {
					seedCount,
					neighborCount,
					seedPaperIds: seeds.map((p) => p.id),
					limitReached: limitReached || neighborCount >= maxTotalNeighbors,
					missingSeedIds,
					resultCount: unique.length,
					pagesPerSeed,
					maxTotalNeighbors,
					failures,
					expansionTable,
					expansionRunId,
					sourceSearchRunId: params.source_search_run_id,
					corpusPath: store.root,
				},
			};
		},
	});
}
