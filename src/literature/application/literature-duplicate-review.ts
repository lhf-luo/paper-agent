import { mergePaperRecords } from "../domain/literature-identifiers.ts";
import type { SearchRun } from "../domain/literature-types.ts";
import { buildCandidatePaperTable } from "./literature-query-planning.ts";
import type { LiteratureStore } from "./literature-store.ts";

export interface DuplicateReviewDecision {
	leftId: string;
	rightId: string;
	decision: "same-work" | "different-work";
	reason?: string;
}

export interface DuplicateReviewOutcome extends Omit<DuplicateReviewDecision, "reason"> {
	status: "applied" | "failed";
	missingPaperIds?: string[];
	error?: string;
}

export interface DuplicateReviewResult {
	run: SearchRun;
	decisionOutcomes: DuplicateReviewOutcome[];
	appliedDecisionCount: number;
	failedDecisionCount: number;
}

function mergeDuplicate(
	run: SearchRun,
	leftIndex: number,
	rightIndex: number,
	decision: DuplicateReviewDecision,
): void {
	run.results[leftIndex] = mergePaperRecords(run.results[leftIndex], run.results[rightIndex]);
	run.results.splice(rightIndex, 1);
	run.deduplicatedCount++;
	const remapped = (run.possibleDuplicates ?? [])
		.map((candidate) => ({
			...candidate,
			leftId: candidate.leftId === decision.rightId ? decision.leftId : candidate.leftId,
			rightId: candidate.rightId === decision.rightId ? decision.leftId : candidate.rightId,
		}))
		.filter((candidate) => candidate.leftId !== candidate.rightId);
	run.possibleDuplicates = [
		...new Map(
			remapped.map((candidate) => [[candidate.leftId, candidate.rightId].sort().join("\n"), candidate]),
		).values(),
	];
}

export async function reviewLiteratureDuplicates(
	store: LiteratureStore,
	searchRunId: string,
	decisions: DuplicateReviewDecision[],
): Promise<DuplicateReviewResult> {
	const run = await store.getSearchRun(searchRunId);
	if (!run) throw new Error(`Search run not found: ${searchRunId}`);
	const decisionOutcomes: DuplicateReviewOutcome[] = [];
	for (const decision of decisions) {
		const outcome = {
			leftId: decision.leftId,
			rightId: decision.rightId,
			decision: decision.decision,
		};
		if (decision.leftId === decision.rightId) {
			decisionOutcomes.push({
				...outcome,
				status: "failed",
				error: "Duplicate decision requires two different paper IDs",
			});
			continue;
		}
		const leftIndex = run.results.findIndex((record) => record.id === decision.leftId);
		const rightIndex = run.results.findIndex((record) => record.id === decision.rightId);
		if (leftIndex < 0 || rightIndex < 0) {
			const missingPaperIds = [
				...(leftIndex < 0 ? [decision.leftId] : []),
				...(rightIndex < 0 ? [decision.rightId] : []),
			];
			decisionOutcomes.push({
				...outcome,
				status: "failed",
				missingPaperIds,
				error: `Paper IDs not found in the search run: ${missingPaperIds.join(", ")}`,
			});
			continue;
		}
		if (decision.decision === "same-work") mergeDuplicate(run, leftIndex, rightIndex, decision);
		else {
			run.possibleDuplicates = (run.possibleDuplicates ?? []).filter(
				(candidate) =>
					!(
						[candidate.leftId, candidate.rightId].includes(decision.leftId) &&
						[candidate.leftId, candidate.rightId].includes(decision.rightId)
					),
			);
		}
		run.identityDecisions = [
			...(run.identityDecisions ?? []),
			{
				leftId: decision.leftId,
				rightId: decision.rightId,
				decision: decision.decision,
				reason: decision.reason?.trim() || undefined,
				decidedAt: new Date().toISOString(),
			},
		];
		decisionOutcomes.push({ ...outcome, status: "applied" });
	}
	const appliedDecisionCount = decisionOutcomes.filter((outcome) => outcome.status === "applied").length;
	const failedDecisionCount = decisionOutcomes.length - appliedDecisionCount;
	if (appliedDecisionCount > 0) {
		run.candidateTable = buildCandidatePaperTable(run.results);
		await store.saveSearchRun(run);
	}
	return { run, decisionOutcomes, appliedDecisionCount, failedDecisionCount };
}
