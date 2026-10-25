import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { graphRadius, citationCap, type GraphData, type CanvasGraphState } from "./canvas-graph-types";
const graphFlushers = new Map<string, () => Promise<void>>();
export async function flushOpenGraph(base: string) {
	await graphFlushers.get(base)?.();
}
interface Queue {
	error?: string;
	state?: CanvasGraphState;
	dirty: boolean;
	revision: number;
	saving?: Promise<void>;
}
async function persistGraphState(base: string, queue: Queue, onError: (e: string) => void) {
	if (queue.saving) {
		await queue.saving;
		if (!queue.dirty) return;
	}
	if (!queue.dirty || !queue.state) return;
	queue.dirty = false;
	queue.error = undefined;
	const next = { ...queue.state, revision: queue.revision };
	const task = api<CanvasGraphState>(`${base}/state`, { method: "PATCH", body: JSON.stringify(next) })
		.then((saved) => {
			queue.revision = saved.revision;
		})
		.catch((e) => {
			queue.error = String(e);
			queue.dirty = true;
			onError(String(e));
		});
	queue.saving = task;
	await task;
	if (queue.saving === task) queue.saving = undefined;
}
function useGraphData(base: string, revision: number, refresh: string, onError: (e: string) => void) {
	const [data, setData] = useState<GraphData>();
	useEffect(() => {
		let active = true;
		void api<GraphData>(`${base}?revision=${revision}&refresh=${refresh}`)
			.then((value) => {
				if (active) setData(value);
			})
			.catch((e) => {
				if (active) onError(String(e));
			});
		return () => {
			active = false;
		};
	}, [base, revision, refresh, onError]);
	return data;
}
function useGraphState(base: string, seed: CanvasGraphState | undefined, onError: (e: string) => void) {
	const [state, setState] = useState<CanvasGraphState>(),
		queue = useRef<Queue>({ dirty: false, revision: 0 });
	useEffect(() => {
		if (seed && (!queue.current.state || seed.revision > queue.current.revision)) {
			queue.current.state = seed;
			queue.current.revision = seed.revision;
			setState(seed);
		}
	}, [seed]);
	const change = useCallback((next: CanvasGraphState) => {
		queue.current.state = next;
		queue.current.dirty = true;
		setState(next);
	}, []);
	const save = useCallback(() => persistGraphState(base, queue.current, onError), [base, onError]);
	useEffect(() => {
		graphFlushers.set(base, async () => {
			await save();
			if (queue.current.error) throw new Error(queue.current.error);
		});
		return () => {
			graphFlushers.delete(base);
		};
	}, [base, save]);
	useEffect(() => {
		if (!state || !queue.current.dirty) return;
		const timer = setTimeout(() => void save(), 600);
		return () => clearTimeout(timer);
	}, [state, save]);
	useEffect(
		() => () => {
			void save();
		},
		[save],
	);
	return { state, change, queue };
}
function startLayout(
	data: GraphData,
	snapshot: CanvasGraphState,
	reset: boolean,
	onComplete: (positions: CanvasGraphState["positions"], fit: boolean) => void,
	onError: (e: string) => void,
) {
	const instance = new Worker(new URL("./canvas-graph-layout.worker.ts", import.meta.url), { type: "module" });
	const fit = reset || snapshot.needsFit || !Object.keys(snapshot.positions).length;
	instance.onmessage = (event) => {
		instance.terminate();
		if (event.data.error) onError(event.data.error);
		else onComplete(event.data.positions, fit);
	};
	instance.onerror = () => {
		instance.terminate();
		onError("图谱布局失败，请重试重新布局");
	};
	instance.postMessage({
		nodes: data.nodes.map((n) => ({
			id: n.id,
			radius: graphRadius(n.citationCount, citationCap(data.nodes)),
			isSeed: n.isSeed,
			...(snapshot.positions[n.id] ?? (n.pinned ? { x: n.x, y: n.y } : {})),
			pinned: n.pinned || snapshot.manualPins?.includes(n.id),
		})),
		edges: data.edges,
		reset,
	});
	return instance;
}
function useGraphLayout(
	data: GraphData | undefined,
	queue: React.RefObject<Queue>,
	change: (s: CanvasGraphState) => void,
	onError: (e: string) => void,
) {
	const [busy, setBusy] = useState(false),
		[tick, setTick] = useState(0),
		reset = useRef(false);
	const generation = useRef(tick);
	generation.current = tick;
	useEffect(() => {
		const snapshot = queue.current.state;
		if (
			!data ||
			!snapshot ||
			!data.nodes.length ||
			(!reset.current && !snapshot.needsFit && data.nodes.every((n) => snapshot.positions[n.id]))
		)
			return;
		setBusy(true);
		const worker = startLayout(
			data,
			snapshot,
			reset.current,
			(positions, fit) => {
				if (tick !== generation.current) return;
				setBusy(false);
				const latest = queue.current.state!;
				change({ ...latest, positions, layoutVersion: data.algorithmVersion, needsFit: fit || latest.needsFit });
			},
			(e) => {
				setBusy(false);
				onError(e);
			},
		);
		reset.current = false;
		return () => {
			worker.onmessage = null;
			worker.terminate();
		};
		// Selection, filters and dragging never restart the static simulation.
	}, [data, tick, change, onError, queue]);
	return {
		layoutBusy: busy,
		relayout: () => {
			reset.current = true;
			setTick((v) => v + 1);
		},
	};
}
export function useCanvasGraph(canvasId: string, revision: number, refresh = 0, runId?: string, refreshKey?: string) {
	const [error, setError] = useState(""),
		base = `/api/canvases/${encodeURIComponent(canvasId)}/${runId ? `search-graphs/${encodeURIComponent(runId)}` : "graph"}`;
	const data = useGraphData(base, revision, `${refresh}:${refreshKey ?? ""}`, setError),
		view = useGraphState(base, data?.state, setError);
	const layout = useGraphLayout(data, view.queue, view.change, setError);
	return { data, state: view.state, error, change: view.change, ...layout };
}
