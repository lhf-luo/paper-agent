import type { PaperRecord } from "../../literature/domain/literature-types.ts";
import { paperIdentityKeys } from "../../literature/domain/reliable-paper-identity.ts";
export const GRAPH_ALGORITHM = {
	version: "citation-idf-1",
	threshold: 0.12,
	topK: 6,
	maxEdges: 1200,
	ticks: 360,
	couplingWeight: 0.6,
	cocitationWeight: 0.4,
	directWeight: 0.35,
} as const;
export interface CitationSet {
	ids: string[];
	status: "missing" | "partial" | "complete";
	provider: string;
	collectedAt?: string;
	cursor?: string;
	capped?: boolean;
	error?: string;
	retryAfter?: string;
}
export interface GraphFeature {
	references: CitationSet;
	citations: CitationSet;
}
export interface GraphRelation {
	id: string;
	from: string;
	to: string;
	label: string;
	kind: "citation" | "association";
	score: number;
	coupling?: number;
	cocitation?: number;
	evidence: {
		references: string[];
		citations: string[];
		sources: string[];
		collectedAt: string[];
		coverage: string[];
	};
}
export type GraphFeatures = Record<string, GraphFeature>;
export function evidenceId(value: string): string {
	const id = value.trim().toLowerCase();
	if (/^(https?:\/\/openalex.org\/)?w[0-9]+$/.test(id)) return `openalex:${id.split("/").at(-1)}`;
	if (/^[a-f0-9]{40}$/.test(id)) return `s2:${id}`;
	return id;
}
function aliases(papers: PaperRecord[]) {
	const result = new Map<string, string>();
	for (const p of papers) {
		for (const id of [p.id, ...p.mergedFrom]) result.set(evidenceId(id), p.id);
		for (const key of paperIdentityKeys(p)) {
			result.set(key, p.id);
			if (key.startsWith("openAlexId:")) result.set(`openalex:${key.slice(11)}`, p.id);
			if (key.startsWith("semanticScholarId:")) result.set(`s2:${key.slice(18)}`, p.id);
		}
	}
	return result;
}
export function existingFeatures(papers: PaperRecord[], saved: GraphFeatures = {}): GraphFeatures {
	const features: GraphFeatures = {};
	for (const p of papers) {
		const empty = (): CitationSet => ({ ids: [], status: "missing", provider: "search-run" });
		features[p.id] = structuredClone(saved[p.id] ?? { references: empty(), citations: empty() });
		const refs = features[p.id].references;
		if (p.referencedWorks?.length && refs.status !== "complete") {
			refs.ids = [...new Set([...refs.ids, ...p.referencedWorks.map(evidenceId)])];
			refs.status = "partial";
			refs.collectedAt ??= p.provenance[0]?.retrievedAt;
			if (refs.provider === "search-run")
				refs.provider =
					p.provenance.find((p) => p.provider === "openalex")?.provider ??
					p.provenance[0]?.provider ??
					"search-run";
		}
	}
	const byId = aliases(papers);
	for (const p of papers)
		for (const path of p.discoveryPaths ?? []) {
			const seed = byId.get(evidenceId(path.seedPaperId ?? ""));
			if (!seed || seed === p.id || !["reference-expansion", "citation-expansion"].includes(path.kind)) continue;
			const [from, to] = path.kind === "reference-expansion" ? [seed, p.id] : [p.id, seed];
			for (const [id, channel, target] of [
				[from, "references", to],
				[to, "citations", from],
			] as const) {
				const set = features[id][channel];
				if (!set.ids.includes(target)) set.ids.push(target);
				if (set.status === "missing") set.status = "partial";
				set.collectedAt ??= path.discoveredAt;
				if (set.provider === "search-run" && path.provider) set.provider = path.provider;
			}
		}
	return features;
}
interface Similarity {
	score: number;
	shared: string[];
}
function channelScores(
	ids: string[],
	features: GraphFeatures,
	channel: keyof GraphFeature,
	canonical: (id: string) => string,
) {
	const observed = ids.filter((id) => features[id][channel].status !== "missing");
	const index = new Map<string, string[]>(),
		norms = new Map<string, number>();
	for (const id of observed)
		for (const key of new Set(features[id][channel].ids.map(canonical))) {
			const bucket = index.get(key) ?? [];
			bucket.push(id);
			index.set(key, bucket);
		}
	const pairs = new Map<string, { dot: number; shared: string[] }>();
	for (const [key, members] of index) {
		const weight = Math.log((observed.length + 1) / (members.length + 1)) ** 2;
		if (weight <= 0) continue;
		for (const id of members) norms.set(id, (norms.get(id) ?? 0) + weight);
		for (let a = 0; a < members.length; a++)
			for (let b = a + 1; b < members.length; b++) {
				const pair = JSON.stringify([members[a], members[b]].sort());
				const value = pairs.get(pair) ?? { dot: 0, shared: [] };
				value.dot += weight;
				value.shared.push(key);
				pairs.set(pair, value);
			}
	}
	const scores = new Map<string, Similarity>();
	for (const [key, pair] of pairs) {
		const [a, b] = JSON.parse(key) as string[];
		if (pair.shared.length >= 2)
			scores.set(key, { score: pair.dot / Math.sqrt(norms.get(a)! * norms.get(b)!), shared: pair.shared.sort() });
	}
	return { scores, norms };
}
function evidence(features: GraphFeatures, from: string, to: string) {
	const sets = [features[from].references, features[from].citations, features[to].references, features[to].citations];
	return {
		references: [] as string[],
		citations: [] as string[],
		sources: [...new Set(sets.map((s) => s.provider))],
		collectedAt: [...new Set(sets.flatMap((s) => (s.collectedAt ? [s.collectedAt] : [])))],
		coverage: sets.map((s) => s.status),
	};
}
export function calculateRelations(papers: PaperRecord[], features: GraphFeatures): GraphRelation[] {
	const byId = aliases(papers),
		ids = papers.map((p) => p.id).sort();
	const canonical = (id: string) => byId.get(evidenceId(id)) ?? evidenceId(id);
	const edges = new Map<string, GraphRelation>();
	const direct = (from: string, to: string) => {
		if (from === to || !features[from] || !features[to]) return;
		const id = JSON.stringify(["citation", from, to]);
		edges.set(id, {
			id,
			from,
			to,
			label: "引用",
			kind: "citation",
			score: GRAPH_ALGORITHM.directWeight,
			evidence: { ...evidence(features, from, to), references: [to] },
		});
	};
	for (const id of ids) {
		for (const ref of features[id].references.ids) direct(id, canonical(ref));
		for (const citing of features[id].citations.ids) direct(canonical(citing), id);
	}
	const bc = channelScores(ids, features, "references", canonical),
		cc = channelScores(ids, features, "citations", canonical);
	for (const key of new Set([...bc.scores.keys(), ...cc.scores.keys()])) {
		const [from, to] = JSON.parse(key) as string[];
		const b = bc.scores.get(key),
			c = cc.scores.get(key);
		const bKnown = Boolean(bc.norms.get(from) && bc.norms.get(to)),
			cKnown = Boolean(cc.norms.get(from) && cc.norms.get(to));
		const coupling = bKnown ? (b?.score ?? 0) : undefined,
			cocitation = cKnown ? (c?.score ?? 0) : undefined;
		const score =
			bKnown && cKnown
				? GRAPH_ALGORITHM.couplingWeight * coupling! + GRAPH_ALGORITHM.cocitationWeight * cocitation!
				: (coupling ?? cocitation ?? 0);
		if (score < GRAPH_ALGORITHM.threshold) continue;
		const id = JSON.stringify(["association", from, to]);
		edges.set(id, {
			id,
			from,
			to,
			label: "引文关联",
			kind: "association",
			score,
			coupling,
			cocitation,
			evidence: { ...evidence(features, from, to), references: b?.shared ?? [], citations: c?.shared ?? [] },
		});
	}
	return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function sparseRelations(edges: GraphRelation[]): GraphRelation[] {
	const sorted = [...edges].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	const parent = new Map<string, string>(),
		selected = new Map<string, GraphRelation>();
	const root = (id: string): string => {
		let r = id;
		while (parent.has(r)) r = parent.get(r)!;
		return r;
	};
	for (const e of sorted) {
		const a = root(e.from),
			b = root(e.to);
		if (a !== b) {
			parent.set(a, b);
			selected.set(e.id, e);
		}
	}
	const add = (e: GraphRelation) => {
		if (selected.size < GRAPH_ALGORITHM.maxEdges) selected.set(e.id, e);
	};
	sorted.filter((e) => e.kind === "citation").forEach(add);
	const counts = new Map<string, number>();
	for (const e of sorted.filter((e) => e.kind === "association")) {
		if ((counts.get(e.from) ?? 0) < GRAPH_ALGORITHM.topK || (counts.get(e.to) ?? 0) < GRAPH_ALGORITHM.topK) add(e);
		counts.set(e.from, (counts.get(e.from) ?? 0) + 1);
		counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
	}
	return [...selected.values()].slice(0, GRAPH_ALGORITHM.maxEdges);
}
