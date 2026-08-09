import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ComparisonMatrix,
	type EvidenceGraph,
	ResearchWorkspace,
	type SkimCard,
	validateResearchRecord,
} from "../src/research-workspace.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function skim(overrides: Partial<SkimCard> = {}): SkimCard {
	return {
		id: "skim-one",
		kind: "skim-card",
		title: "Stateful fuzzing skim card",
		authorship: {
			type: "human",
			author: "alice",
			humanReviewed: true,
			reviewedBy: "alice",
			reviewedAt: "2026-08-01T00:00:00.000Z",
		},
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		revision: 0,
		paperId: "paper-one",
		researchQuestion: "How is protocol state recovered?",
		problem: "State explosion",
		method: "State model inference",
		datasets: "Protocol implementations",
		findings: "Improved coverage",
		limitations: "Limited protocols",
		unknowns: "Generalization",
		sources: [
			{ paperId: "paper-one", versionSha256: "a".repeat(64), page: 4, quote: "The model recovers protocol state." },
		],
		...overrides,
	};
}

function graph(overrides: Partial<EvidenceGraph> = {}): EvidenceGraph {
	return {
		id: "graph-one",
		kind: "evidence-graph",
		title: "Evidence graph",
		authorship: { type: "ai-assisted", author: "model:test", model: "fixture", humanReviewed: false },
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		revision: 0,
		question: "Does inferred state improve coverage?",
		humanConclusion: "Not yet reviewed",
		aiSuggestions: "Compare against ablations.",
		cards: [
			{
				id: "card-one",
				claim: "Coverage increases",
				stance: "support",
				evidence: "Reported in Table 3",
				confidence: "medium",
				sources: [{ paperId: "paper-one", page: 8, quote: "Coverage increased by 12%." }],
			},
		],
		edges: [],
		...overrides,
	};
}

describe("research workspace", () => {
	it("keeps an empty read-only workspace off disk", async () => {
		const parent = await mkdtemp(join(tmpdir(), "paper-agent-research-readonly-"));
		temporaryPaths.push(parent);
		const root = join(parent, "not-created");
		const workspace = new ResearchWorkspace(root);
		expect(await workspace.list()).toEqual([]);
		expect(await workspace.audit()).toEqual([]);
		await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("persists revisions, quote hashes, audit events, and deterministic derived records", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-research-"));
		temporaryPaths.push(root);
		const workspace = new ResearchWorkspace(root);
		const first = await workspace.save(skim());
		expect(first.revision).toBe(1);
		if (first.kind !== "skim-card") throw new Error("expected skim card");
		expect(first.sources[0].quoteSha256).toBe(createHash("sha256").update(first.sources[0].quote!).digest("hex"));
		const second = await workspace.save(skim({ findings: "Improved coverage and depth" }));
		expect(second.revision).toBe(2);
		expect(second.createdAt).toBe(first.createdAt);
		expect(await workspace.list()).toMatchObject([{ id: "skim-one", revision: 2 }]);
		expect(await workspace.audit()).toMatchObject([
			{ action: "update", revision: 2 },
			{ action: "create", revision: 1 },
		]);
		const derived = workspace.toDerivedRecord(second);
		expect(derived).toMatchObject({
			paperId: "paper-one",
			operation: "skim-card",
			pipelineVersion: "research-workspace-v1",
		});
		expect(derived.inputHashes).toContain("a".repeat(64));
		expect(derived.inputHashes).toContain((second as SkimCard).sources[0].quoteSha256);
	});

	it("serializes concurrent revisions and prevents AI from overwriting human work or changing a human conclusion", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-research-lock-"));
		temporaryPaths.push(root);
		const workspace = new ResearchWorkspace(root);
		await workspace.save(skim());
		await expect(
			workspace.save(skim({ authorship: { type: "ai-assisted", author: "model:test", humanReviewed: false } })),
		).rejects.toThrow("cannot overwrite");

		await workspace.save(graph());
		await expect(workspace.save(graph({ humanConclusion: "AI changed this" }))).rejects.toThrow("human conclusion");

		const concurrentRoot = await mkdtemp(join(tmpdir(), "paper-agent-research-revisions-"));
		temporaryPaths.push(concurrentRoot);
		const concurrent = new ResearchWorkspace(concurrentRoot);
		await Promise.all(
			Array.from({ length: 5 }, (_value, index) => concurrent.save(skim({ findings: `revision ${index}` }))),
		);
		expect(await concurrent.get("skim-card", "skim-one")).toMatchObject({ revision: 5 });
		expect(await concurrent.audit()).toHaveLength(5);
	});

	it("preserves AI provenance when a distinct human reviewer approves a draft", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-research-review-"));
		temporaryPaths.push(root);
		const workspace = new ResearchWorkspace(root);
		const reviewed = await workspace.save(
			graph({
				authorship: {
					type: "ai-assisted",
					author: "model:fixture",
					model: "fixture",
					humanReviewed: true,
					reviewedBy: "alice",
					reviewedAt: "2026-08-02T00:00:00.000Z",
				},
			}),
		);
		expect(reviewed.authorship).toMatchObject({
			type: "ai-assisted",
			author: "model:fixture",
			humanReviewed: true,
			reviewedBy: "alice",
		});
		expect(workspace.toDerivedRecord(reviewed).normalizedConfig).toMatchObject({
			authorType: "ai-assisted",
			humanReviewed: true,
			reviewedBy: "alice",
		});
		await expect(
			workspace.save(
				graph({
					authorship: {
						type: "ai-assisted",
						author: "model:fixture",
						humanReviewed: true,
						reviewedBy: "model:fixture",
						reviewedAt: "2026-08-02T00:00:00.000Z",
					},
				}),
			),
		).rejects.toThrow("distinct");
	});

	it("returns structured validation errors for malformed nested arrays", () => {
		expect(() => validateResearchRecord({ ...skim(), sources: null } as unknown as SkimCard)).toThrow(
			"bounded source locator array",
		);
		expect(() =>
			validateResearchRecord({ ...graph(), cards: [{ ...graph().cards[0], sources: null }] } as unknown as EvidenceGraph),
		).toThrow("bounded source locator array");
	});

	it("accepts canonical provider identifiers in skim cards, sources, and comparison matrices", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-research-identifiers-"));
		temporaryPaths.push(root);
		const workspace = new ResearchWorkspace(root);
		const card = await workspace.save(
			skim({
				paperId: "arxiv:1207.0580",
				sources: [{ paperId: "doi:10.5555/example/path", page: 2, quote: "Canonical IDs remain intact." }],
			}),
		);
		expect(card).toMatchObject({ paperId: "arxiv:1207.0580", sources: [{ paperId: "doi:10.5555/example/path" }] });

		const doi = "doi:10.5555/example/path";
		const matrix: ComparisonMatrix = {
			id: "matrix-one",
			kind: "comparison-matrix",
			title: "Canonical identifier matrix",
			authorship: { type: "human", author: "alice", humanReviewed: true },
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
			revision: 0,
			paperIds: [doi],
			dimensions: ["method"],
			cells: { [doi]: { method: { value: "State inference", sources: [{ paperId: doi, page: 3 }] } } },
		};
		const stored = await workspace.save(matrix);
		expect(stored).toMatchObject({ paperIds: [doi], cells: { [doi]: { method: { value: "State inference" } } } });
	});
});
