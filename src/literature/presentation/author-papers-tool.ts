import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectAuthorPapers } from "../application/literature-author-expansion.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";

export function registerAuthorPapersTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "find_author_papers",
		label: "Find an author's other papers",
		description:
			"Find other works by one author of a saved personal-library paper. Resolve the author from the seed work in OpenAlex, Semantic Scholar, and DBLP; save deduplicated candidates as an author-expansion Search Run without adding papers to the personal library.",
		promptSnippet: "Find other papers by a selected author of a personal paper",
		promptGuidelines: [
			"Use paper_id from the personal library and an author_name uniquely present in that paper's authors list.",
			"This tool requires a verified author identity in each source; unresolved or failed sources are reported, not guessed by name.",
			"Review possible duplicates before filtering the returned search_run_id. Use filter_search_run_results for topic screening, then save selected results only if requested.",
		],
		parameters: Type.Object({
			paper_id: Type.String({ minLength: 1, description: "Seed Paper ID already in the personal library" }),
			author_name: Type.String({ minLength: 1, description: "One uniquely matching author from the seed paper" }),

			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			max_results_per_provider: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 500,
					description: "Default: 100; results at this cap are reported as truncated",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const store = new LiteratureStore(resolveCorpusRoot(ctx.cwd, "personal"), "personal");
			const seed = await store.getPaper(params.paper_id);
			if (!seed) throw new Error(`Paper is not in the personal library : ${params.paper_id}`);
			const run = await collectAuthorPapers({
				seed,
				authorName: params.author_name,

				yearFrom: params.year_from,
				yearTo: params.year_to,
				maxResultsPerProvider: params.max_results_per_provider,
				signal,
			});
			await store.saveSearchRun(run);
			const sourceLines = run.providers.map((provider) => {
				const source = run.authorExpansion?.sources[provider as "openalex" | "semanticscholar" | "dblp"];
				return `${provider}: ${source?.status ?? "failed"}; author_id=${source?.authorId ?? "unresolved"}; fetched=${source?.fetchedCount ?? 0}; truncated=${source?.truncated ?? false}${source?.message ? `; ${source.message}` : ""}`;
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`Author expansion Search Run: ${run.id}`,
							`Seed: ${seed.id}; author: ${run.authorExpansion?.authorName}`,
							`Other papers: ${run.results.length} unique; possible duplicates: ${run.possibleDuplicates?.length ?? 0}. Personal library unchanged.`,
							...sourceLines,
							"Candidate Paper IDs and titles:",
							...run.results.slice(0, 60).map((record) => `- ${record.id} | ${record.title}`),
							run.results.length > 60
								? `Only first 60 shown; ${run.results.length - 60} more in the Search Run.`
								: "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					searchRunId: run.id,
					seedPaperId: seed.id,
					authorName: run.authorExpansion?.authorName,
					resultCount: run.results.length,
					possibleDuplicates: run.possibleDuplicates ?? [],
					sources: run.authorExpansion?.sources,
					candidateTable: run.candidateTable?.slice(0, 60),
				},
			};
		},
	});
}
