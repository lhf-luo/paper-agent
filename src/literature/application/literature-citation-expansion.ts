import { randomUUID } from "node:crypto";
import type { LiteratureStore } from "./literature-store.ts";
import type { PaperRecord, SearchRun, LiteratureProvider, ProviderFailure } from "../domain/literature-types.ts";
import { unionPapers } from "../domain/citation-seeds.ts";
import { samePaper } from "../domain/reliable-paper-identity.ts";
import { mergePaperRecords } from "../domain/literature-identifiers.ts";
import { searchOpenAlexByDoi } from "../infrastructure/literature-providers.ts";
import { citationNeighbors } from "./citation-neighbors.ts";
import { tagCitationExpansionRecords } from "./literature-query-planning.ts";
export interface CitationExpansionInput {
	seed_ids: string[];
	direction?: "references" | "citations" | "both";
	depth?: number;
	year_from?: number;
	year_to?: number;
	max_neighbors_per_seed?: number;
	pages_per_seed?: number;
	max_total_neighbors?: number;
	source_search_run_id?: string;
}
export function validateCitationExpansion(input: CitationExpansionInput) {
	if (
		!Array.isArray(input.seed_ids) ||
		!input.seed_ids.length ||
		input.seed_ids.length > 20 ||
		input.seed_ids.some((id) => typeof id !== "string" || !id)
	)
		throw new Error("请选择 1–20 篇起点论文");
	if (input.direction !== undefined && !["references", "citations", "both"].includes(input.direction))
		throw new Error("引用扩展方向无效");
	for (const [value, min, max] of [
		[input.depth, 1, 2],
		[input.max_neighbors_per_seed, 1, 100],
		[input.pages_per_seed, 1, 5],
		[input.max_total_neighbors, 1, 1000],
		[input.year_from, 1000, 9999],
		[input.year_to, 1000, 9999],
	])
		if (value !== undefined && (!Number.isInteger(value) || value < min! || value > max!))
			throw new Error("扩展参数超出允许范围");
	if (input.year_from !== undefined && input.year_to !== undefined && input.year_from > input.year_to)
		throw new Error("开始年份不能晚于结束年份");
}
async function loadSeeds(store: LiteratureStore, input: CitationExpansionInput, signal?: AbortSignal) {
	const loaded = await Promise.all(input.seed_ids.map(async (id) => ({ id, paper: await store.getPaper(id) })));
	const missingSeedIds = loaded.filter((p) => !p.paper).map((p) => p.id);
	const records = unionPapers(loaded.flatMap((p) => (p.paper ? [p.paper] : [])));
	if (!records.length) throw new Error("None of the seed_ids exist in the selected corpus");
	const seeds = await Promise.all(
		records.map(async (seed) => {
			signal?.throwIfAborted();
			if (!seed.identifiers.doi || seed.identifiers.openAlexId) return seed;
			try {
				const p = await searchOpenAlexByDoi(seed.identifiers.doi, { signal, queryLabel: `seed-enrich:${seed.id}` });
				return p
					? {
							...seed,
							identifiers: {
								...seed.identifiers,
								...(p.identifiers.openAlexId ? { openAlexId: p.identifiers.openAlexId } : {}),
							},
							referencedWorks: seed.referencedWorks?.length ? seed.referencedWorks : p.referencedWorks,
						}
					: seed;
			} catch {
				signal?.throwIfAborted();
				return seed;
			}
		}),
	);
	return { seeds: unionPapers(seeds), missingSeedIds };
}
class CitationRound {
	readonly seeds: PaperRecord[];
	readonly input: CitationExpansionInput;
	readonly discovered: PaperRecord[] = [];
	readonly attempted = new Set<LiteratureProvider>();
	readonly failures: ProviderFailure[] = [];
	limitReached = false;
	readonly total: number;
	readonly perSeed: number;
	readonly pages: number;
	readonly depth: number;
	constructor(seeds: PaperRecord[], input: CitationExpansionInput) {
		this.seeds = seeds;
		this.input = input;
		this.perSeed = input.max_neighbors_per_seed ?? 30;
		this.depth = input.depth ?? 1;
		this.pages = input.pages_per_seed ?? 3;
		this.total = input.max_total_neighbors ?? Math.min(1000, this.perSeed * seeds.length * this.depth);
	}
	async expand(seed: PaperRecord, level: number, signal?: AbortSignal) {
		let remaining = Math.min(this.perSeed, this.total - this.discovered.length);
		const next: PaperRecord[] = [];
		const accept = (records: PaperRecord[], relationship: "reference" | "citation", provider: LiteratureProvider) => {
			if (records.length >= remaining) this.limitReached = true;
			for (const record of unionPapers(records)) {
				const [tagged] = tagCitationExpansionRecords(
					[record],
					seed,
					relationship,
					provider,
					level,
					new Date().toISOString(),
				);
				const previous = [...this.seeds, ...this.discovered].find((p) => samePaper(p, record));
				if (previous) {
					Object.assign(previous, mergePaperRecords(previous, tagged));
					continue;
				}
				if (
					record.year !== undefined &&
					((this.input.year_from !== undefined && record.year < this.input.year_from) ||
						(this.input.year_to !== undefined && record.year > this.input.year_to))
				)
					continue;
				if (remaining <= 0 || this.discovered.length >= this.total) continue;
				this.discovered.push(tagged);
				next.push(tagged);
				remaining--;
			}
		};
		for (const direction of ["references", "citations"] as const) {
			if (this.input.direction && this.input.direction !== "both" && this.input.direction !== direction) continue;
			await citationNeighbors({
				seed,
				direction,
				pages: this.pages,
				remaining: () => remaining,
				signal,
				attempted: this.attempted,
				failures: this.failures,
				accept,
			});
		}
		return next;
	}
	async execute(signal?: AbortSignal, report?: (message: string) => void) {
		let frontier = this.seeds;
		for (let level = 1; level <= this.depth; level++) {
			const next: PaperRecord[] = [];
			for (const seed of frontier) {
				signal?.throwIfAborted();
				if (this.discovered.length >= this.total) break;
				report?.(`正在扩展 ${seed.title}；已取得 ${this.discovered.length} 篇邻居`);
				next.push(...(await this.expand(seed, level, signal)));
			}
			frontier = next;
			if (!frontier.length || this.discovered.length >= this.total) break;
		}
	}
	run(startedAt: string): SearchRun {
		const results = unionPapers([...this.seeds, ...this.discovered]),
			providers = [...this.attempted];
		return {
			id: `search-expansion-${randomUUID()}`,
			startedAt,
			completedAt: new Date().toISOString(),
			queries: this.seeds.map((p) => p.id),
			filters: { yearFrom: this.input.year_from, yearTo: this.input.year_to },
			providers,
			pagesPerProvider: this.pages,
			maxResultsPerProvider: this.total,
			results,
			failures: this.failures,
			deduplicatedCount: results.length,
			sourceCounts: Object.fromEntries(
				providers.map((provider) => [
					provider,
					this.discovered.filter((p) => p.provenance.some((item) => item.provider === provider)).length,
				]),
			),
			citationExpansion: {
				direction: this.input.direction ?? "both",
				depth: this.depth,
				pagesPerSeed: this.pages,
				maxNeighborsPerSeed: this.perSeed,
				maxTotalNeighbors: this.total,
				limitReached: this.limitReached || this.discovered.length >= this.total,
			},
			runKind: "citation-expansion",
			parentSearchRunId: this.input.source_search_run_id,
			seedPaperIds: this.seeds.map((p) => p.id),
			seedSnapshots: this.seeds,
			scope: "personal",
			mode: "once",
		};
	}
}
/** Shared entry point for Pi tools and direct HTTP background jobs. Never invokes an LLM. */
export async function expandCitationNetwork(
	store: LiteratureStore,
	input: CitationExpansionInput,
	signal?: AbortSignal,
	report?: (message: string) => void,
) {
	validateCitationExpansion(input);
	const startedAt = new Date().toISOString();
	const { seeds, missingSeedIds } = await loadSeeds(store, input, signal),
		round = new CitationRound(seeds, input);
	await round.execute(signal, report);
	signal?.throwIfAborted();
	const run = round.run(startedAt);
	await store.saveSearchRun(run);
	return { run, missingSeedIds, seedCount: seeds.length, neighborCount: run.results.length - seeds.length };
}
