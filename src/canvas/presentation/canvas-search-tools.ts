import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CanvasResearchService } from "../application/canvas-research-service.ts";
import { SearchRunGraphs } from "../application/search-run-graphs.ts";

export function registerCanvasSearchTools(pi: ExtensionAPI, service: CanvasResearchService) {
	pi.registerTool({
		name: "show_search_run_graph",
		label: "展示搜索结果图谱",
		description:
			"Open a saved Search Run as an independent graph view available in the left graph manager in the bound canvas workspace. Does not search, import papers, create canvas nodes, or require a change proposal. Reopening a run reuses its graph and positions. Citation seeds remain visible as context even with a filter. Existing citation evidence is rendered without network enrichment. Returns total resultCount, matchedCount, displayedCount (including context seeds), and seedCount.",
		promptGuidelines: [
			"After citation or author expansion (including browser-collected author profiles), pass the returned Search Run ID here. For ordinary keyword searches, only display a graph when the user explicitly requests it. Do not create a sidebar or add unimported candidates to the relationship canvas.",
			"A filter_result_id optionally narrows this same graph; it must belong to this Search Run. Unknown or missing papers must never be fabricated.",
		],
		parameters: Type.Object({
			search_run_id: Type.String({ minLength: 1 }),
			filter_result_id: Type.Optional(Type.String({ minLength: 1 })),
		}),
		async execute(_id, input, signal) {
			signal?.throwIfAborted();
			const details = await new SearchRunGraphs(service.library, service.canvasId).show(
				input.search_run_id,
				service.sessionId,
				input.filter_result_id,
			);
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}
