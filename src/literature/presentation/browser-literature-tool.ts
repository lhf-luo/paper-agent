import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stageBrowserLiterature } from "../application/literature-browser-import.ts";

const parameters = Type.Object({
	source_url: Type.String({
		minLength: 1,
		maxLength: 8192,
		description: "Author profile or publication-list URL actually visited",
	}),
	label: Type.String({ minLength: 1, maxLength: 500, description: "Author name or publication-list name" }),
	records: Type.Array(
		Type.Object({
			title: Type.String({ minLength: 1, maxLength: 2000 }),
			authors: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 500 }),
			year: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			venue: Type.Optional(Type.String({ maxLength: 2000 })),
			abstract: Type.Optional(Type.String({ maxLength: 30000 })),
			doi: Type.Optional(Type.String({ maxLength: 2000 })),
			arxiv_id: Type.Optional(Type.String({ maxLength: 200 })),
			url: Type.Optional(Type.String({ maxLength: 8192 })),
			citation_count: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		{ maxItems: 500 },
	),
	year_from: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 9999,
			description: "Inclusive publication year; unknown years are reported and excluded when bounded",
		}),
	),
	year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
	complete: Type.Optional(Type.Boolean({ default: false })),
	expected_count: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"Expected publications across traversed pages (before year filtering), only when actually observed; never use cited-by totals",
		}),
	),
	note: Type.Optional(Type.String({ maxLength: 4000 })),
	append_to_search_run_id: Type.Optional(Type.String({ maxLength: 200 })),
});

export function registerBrowserLiteratureTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "stage_browser_literature",
		label: "Stage browser-collected papers",
		description:
			"Save publication metadata actually read through browser MCP into a durable once-mode Search Run. Does not search the web itself, add personal-library papers, or download PDFs. Supports inclusive year_from/year_to and appending pages from the same profile and year range. Google Scholar profiles become author-expansion Search Runs; no personal-library seed is required.",
		promptGuidelines: [
			"Use only metadata observed on the provided page. Do not infer missing authors, abstracts, DOI or years.",
			"For Google Scholar open the exact user profile, sort papers by year, read visible publication rows and paginate/Show more until the requested year range is covered. Do not use the cited-by count as the publication count. Preserve actual publication detail URLs. Keep complete=false until coverage and counts have been checked. On CAPTCHA, access denial or incomplete pagination, stop browsing and record partial coverage with a note.",
			"In a canvas, use returned searchRunId with show_search_run_graph. Outside a canvas, use existing filter_search_run_results and update_literature_sidebar. Personal-library additions still require the existing explicit selection/confirmation flow.",
		],
		parameters,
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const run = await stageBrowserLiterature(ctx.cwd, {
				sourceUrl: params.source_url,
				label: params.label,
				records: params.records,
				complete: params.complete,
				expectedCount: params.expected_count,
				note: params.note,
				appendTo: params.append_to_search_run_id,
				yearFrom: params.year_from,
				yearTo: params.year_to,
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`Browser Search Run: ${run.id}`,
							`${run.results.length} unique candidates; coverage=${run.coverage?.status}. Personal library unchanged.`,
							...(run.searchPlan?.notes ?? []),
							...run.results.slice(0, 60).map((paper) => `${paper.id} | ${paper.title}`),
							run.results.length > 60
								? "Only the first 60 candidates are shown; read remaining records from the Search Run."
								: "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					searchRunId: run.id,
					resultCount: run.results.length,
					coverage: run.coverage,
					authorExpansion: run.authorExpansion,
					yearRange: run.filters,
					observedCount: run.browserCollection?.observed.length,
					excludedYearCount: run.browserCollection?.excludedYearCount,
					unknownYearCount: run.browserCollection?.unknownYearCount,
					candidateTable: run.candidateTable?.slice(0, 60),
				},
			};
		},
	});
}
