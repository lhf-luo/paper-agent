import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import { tagCitationExpansionRecords } from "../application/literature-query-planning.ts";
import { buildCitationExpansionTable, collectCitationPages } from "../application/literature-search-planning.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { deduplicatePaperRecords } from "../domain/literature-identifiers.ts";
import type { LiteratureProvider, PaperRecord, SearchRun } from "../domain/literature-types.ts";
import {
	fetchOpenAlexWorks,
	searchOpenAlexByDoi,
	searchOpenAlexCitations,
	searchSemanticScholarCitations,
} from "../infrastructure/literature-providers.ts";
import { formatCitationExpansionTable } from "./collection-tool-formatting.ts";
import { scopeSchema } from "./collection-tool-schemas.ts";

export function registerCitationExpansionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "expand_citation_network",
		label: "Expand citation network",
		description:
			"Expand references and/or citing works from OpenAlex records already stored in a persistent corpus. Expansion is bounded, provenance-preserving, and deduplicated. Results are shown to the user but NOT automatically written to the corpus — the user decides later whether to save them.",
		promptSnippet: "Expand a paper's bounded OpenAlex citation neighborhood",
		promptGuidelines: [
			"Use citation expansion after a focused seed search, not as a substitute for a documented query strategy.",
			"Expansion results are staged in a temporary Search Run and are not saved to the personal library automatically.",
			"Before creating a sidebar, screen the temporary Search Run with filter_search_run_results, then pass its search_run_id and filter_result_id with fields, annotation_fields, and annotations to update_literature_sidebar.",
		],
		parameters: Type.Object({
			seed_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "Corpus paper ids" }),
			direction: Type.Optional(
				Type.Union([Type.Literal("references"), Type.Literal("citations"), Type.Literal("both")]),
			),
			depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
			max_neighbors_per_seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			pages_per_seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
			max_total_neighbors: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
			source_search_run_id: Type.Optional(Type.String({ description: "Search run that supplied the seed papers" })),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			if (scope === "team") {
				throw new Error(
					"Citation expansion cannot write directly to a team corpus; expand in personal scope, then promote",
				);
			}
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			const loadedSeeds = await Promise.all(
				params.seed_ids.map(async (id) => ({ id, record: await store.getPaper(id) })),
			);
			const missingSeedIds = loadedSeeds.filter((item) => !item.record).map((item) => item.id);
			const loadedSeedRecords = loadedSeeds
				.map((item) => item.record)
				.filter((record): record is PaperRecord => Boolean(record));
			if (loadedSeedRecords.length === 0) throw new Error("None of the seed_ids exist in the selected corpus");
			// 用 DOI 从 OpenAlex 补全种子的 openAlexId + referencedWorks, 使引用/被引扩展优先走 OpenAlex(限流宽松),
			// 避免 Semantic Scholar 限流导致整个扩展失败。
			const seeds = await Promise.all(
				loadedSeedRecords.map(async (seed) => {
					const doi = seed.identifiers?.doi;
					if (!doi || seed.identifiers?.openAlexId) return seed;
					try {
						const record = await searchOpenAlexByDoi(doi, {
							signal,
							queryLabel: `seed-enrich:${seed.id}`,
						});
						if (!record) return seed;
						return {
							...seed,
							identifiers: {
								...seed.identifiers,
								...(record.identifiers?.openAlexId ? { openAlexId: record.identifiers.openAlexId } : {}),
							},
							referencedWorks: seed.referencedWorks?.length ? seed.referencedWorks : record.referencedWorks,
						};
					} catch {
						return seed;
					}
				}),
			);
			const direction = params.direction ?? "both";
			const limit = params.max_neighbors_per_seed ?? 30;
			const depth = params.depth ?? 1;
			const pagesPerSeed = params.pages_per_seed ?? 3;
			const maxTotalNeighbors = params.max_total_neighbors ?? Math.min(1000, limit * seeds.length * depth);
			let frontier = seeds;
			const discovered: PaperRecord[] = [];
			const failures: string[] = [];
			const visited = new Set(seeds.map((seed) => seed.id));
			for (let level = 1; level <= depth; level++) {
				const next: PaperRecord[] = [];
				for (const seed of frontier) {
					if (discovered.length >= maxTotalNeighbors) break;
					let seedRemaining = Math.min(limit, maxTotalNeighbors - discovered.length);
					const accept = (
						records: PaperRecord[],
						relationship: "reference" | "citation",
						provider: LiteratureProvider,
					) => {
						const discoveredAt = new Date().toISOString();
						for (const record of deduplicatePaperRecords(records)) {
							if (seedRemaining <= 0 || discovered.length >= maxTotalNeighbors) break;
							if (visited.has(record.id)) continue;
							const [tagged] = tagCitationExpansionRecords(
								[record],
								seed,
								relationship,
								provider,
								level,
								discoveredAt,
							);
							visited.add(record.id);
							next.push(tagged);
							discovered.push(tagged);
							seedRemaining--;
						}
					};
					if ((direction === "references" || direction === "both") && seedRemaining > 0) {
						try {
							if (seed.referencedWorks?.length) {
								accept(
									await fetchOpenAlexWorks(seed.referencedWorks.slice(0, seedRemaining), {
										signal,
										queryLabel: `references:${seed.id}`,
									}),
									"reference",
									"openalex",
								);
							} else if (seed.identifiers.semanticScholarId) {
								accept(
									await collectCitationPages(
										(pageLimit, cursor) =>
											searchSemanticScholarCitations(
												seed.identifiers.semanticScholarId ?? "",
												"references",
												{ limit: pageLimit, cursor, signal, queryLabel: `references:${seed.id}` },
											),
										seedRemaining,
										pagesPerSeed,
									),
									"reference",
									"semanticscholar",
								);
							}
						} catch (error) {
							failures.push(`${seed.id}/references: ${readableErrorMessage(error)}`);
						}
					}
					if ((direction === "citations" || direction === "both") && seedRemaining > 0) {
						try {
							const workId = seed.identifiers.openAlexId;
							if (workId) {
								accept(
									await collectCitationPages(
										(pageLimit, cursor) =>
											searchOpenAlexCitations(workId, {
												limit: pageLimit,
												cursor,
												signal,
												queryLabel: `citations:${seed.id}`,
											}),
										seedRemaining,
										pagesPerSeed,
									),
									"citation",
									"openalex",
								);
							} else if (seed.identifiers.semanticScholarId) {
								accept(
									await collectCitationPages(
										(pageLimit, cursor) =>
											searchSemanticScholarCitations(seed.identifiers.semanticScholarId ?? "", "citations", {
												limit: pageLimit,
												cursor,
												signal,
												queryLabel: `citations:${seed.id}`,
											}),
										seedRemaining,
										pagesPerSeed,
									),
									"citation",
									"semanticscholar",
								);
							}
						} catch (error) {
							failures.push(`${seed.id}/citations: ${readableErrorMessage(error)}`);
						}
					}
				}
				frontier = next;
				if (frontier.length === 0 || discovered.length >= maxTotalNeighbors) break;
			}
			const unique = discovered;
			const expansionTable = buildCitationExpansionTable(unique);
			// 扩展结果不写入个人库, 但保存为一个临时 search run, 供论文清单匹配和后续保存定位。
			let expansionRunId: string | undefined;
			if (unique.length) {
				const now = new Date().toISOString();
				const expansionProviders = [
					...new Set(
						unique
							.flatMap((record) => record.provenance.map((item) => item.provider))
							.filter(
								(provider): provider is LiteratureProvider =>
									provider === "openalex" || provider === "semanticscholar",
							),
					),
				];
				const run: SearchRun = {
					id: `search-expansion-${randomUUID()}`,
					startedAt: now,
					completedAt: now,
					queries: seeds.map((seed) => seed.id),
					filters: {},
					providers: expansionProviders,
					pagesPerProvider: pagesPerSeed,
					maxResultsPerProvider: maxTotalNeighbors,
					results: unique,
					failures: [],
					sourceCounts: Object.fromEntries(
						expansionProviders.map((provider) => [
							provider,
							unique.filter((record) => record.provenance.some((item) => item.provider === provider)).length,
						]),
					),
					deduplicatedCount: unique.length,
					scope: "personal",
					mode: "once",
					namespace,
					runKind: "citation-expansion",
					parentSearchRunId: params.source_search_run_id,
					seedPaperIds: seeds.map((seed) => seed.id),
				};
				try {
					await store.saveSearchRun(run);
					expansionRunId = run.id;
				} catch {
					// 保存临时 run 是尽力而为, 失败不影响返回结果。
				}
			}
			return {
				content: [
					{
						type: "text",
						text: [
							`Expanded ${seeds.length} seeds to ${unique.length} unique neighboring papers (not saved to the corpus; staged in ${expansionRunId ?? "no temporary run"}).`,
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
					seedCount: seeds.length,
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
