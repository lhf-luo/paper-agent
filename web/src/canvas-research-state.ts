import { useCallback, useEffect, useRef, useState } from "react";
import type {
	CanvasChangeProposal,
	CanvasResearchAnalysis,
	CanvasResearchRecord,
	CanvasSearchPlan,
} from "../../src/canvas/domain/canvas-research";
import type { AnalysisView, ResearchClient } from "./canvas-research-api";

interface ResearchRecords {
	analyses: CanvasResearchRecord<CanvasResearchAnalysis>[];
	proposals: CanvasResearchRecord<CanvasChangeProposal>[];
	plans: CanvasResearchRecord<CanvasSearchPlan>[];
	run?: AnalysisView;
}
async function fetchRecords(client: ResearchClient, runId: string, offset: number): Promise<ResearchRecords> {
	const [a, p, s] = await Promise.all([
		client.get<{ analyses: ResearchRecords["analyses"] }>("analyses"),
		client.get<{ proposals: ResearchRecords["proposals"] }>("proposals"),
		client.get<{ plans: ResearchRecords["plans"] }>("searches"),
	]);
	let run: AnalysisView | undefined;
	if (runId) run = await client.get<AnalysisView>("analyses", { id: runId, offset });
	else if (a.analyses.length)
		run = (await client.get<{ analysis?: AnalysisView }>("analyses", { latest: "matching" })).analysis;
	return { analyses: a.analyses, proposals: p.proposals, plans: s.plans, run };
}
export function useResearchRecords(client: ResearchClient) {
	const [records, setRecords] = useState<ResearchRecords>({ analyses: [], proposals: [], plans: [] });
	const [runId, setRunId] = useState("");
	const [offset, setOffset] = useState(0);
	const refreshRef = useRef<() => void>(() => {});
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true,
			generation = 0;
		let timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			const current = ++generation;
			try {
				const data = await fetchRecords(client, runId, offset);
				if (active && current === generation) {
					setRecords(data);
					setError("");
				}
			} catch (e) {
				if (active && current === generation) setError(String(e));
			}
		};
		void load();
		refreshRef.current = () => void load();
		const events = client.events();
		events.onmessage = () => {
			clearTimeout(timer);
			timer = setTimeout(() => void load(), 250);
		};
		return () => {
			active = false;
			refreshRef.current = () => {};
			events.close();
			clearTimeout(timer);
		};
	}, [client, runId, offset]);
	const refresh = useCallback(() => refreshRef.current(), []);
	return {
		...records,
		error,
		runId: runId || records.run?.id || "",
		setRunId: (id: string) => {
			setRunId(id);
			setOffset(0);
		},
		setOffset: (next: number) => {
			if (!runId && records.run) setRunId(records.run.id);
			setOffset(next);
		},
		refresh,
	};
}
