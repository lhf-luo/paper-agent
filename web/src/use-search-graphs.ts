import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface SearchGraphRecord {
	runId: string;
	title: string;
	openedAt: string;
	closed: boolean;
}
function useGraphRecords(canvasId: string | undefined, onOpen: (id: string) => void) {
	const [graphs, setGraphs] = useState<SearchGraphRecord[]>([]),
		[error, setError] = useState("");
	const openRef = useRef(onOpen);
	openRef.current = onOpen;
	const reload = useRef<() => Promise<void>>(async () => {});
	useEffect(() => {
		setGraphs([]);
		if (!canvasId) return;
		let current = true,
			generation = 0;
		const stamps = new Map<string, string>();
		let initialized = false;
		let timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			const version = ++generation;
			try {
				const data = await api<{ graphs: SearchGraphRecord[] }>(
					`/api/canvases/${encodeURIComponent(canvasId)}/search-graphs`,
				);
				if (!current || version !== generation) return;
				setGraphs(data.graphs);
				const opened = data.graphs
					.filter((g) => !g.closed && stamps.get(g.runId) !== g.openedAt)
					.sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
				for (const g of data.graphs) stamps.set(g.runId, g.openedAt);
				if (opened && initialized) openRef.current(opened.runId);
				initialized = true;
				setError("");
			} catch (e) {
				if (current) setError(String(e));
			}
		};
		reload.current = load;
		void load();
		const events = new EventSource(`/api/canvases/${encodeURIComponent(canvasId)}/research/events`);
		events.onmessage = () => {
			clearTimeout(timer);
			timer = setTimeout(() => void load(), 150);
		};
		return () => {
			current = false;
			reload.current = async () => {};
			clearTimeout(timer);
			events.close();
		};
	}, [canvasId]);
	return { graphs, error, reload };
}
export function useSearchGraphs(canvasId: string | undefined, onOpen: (id: string) => void) {
	const { graphs, error, reload } = useGraphRecords(canvasId, onOpen);

	const close = async (runId: string) => {
		await api(`/api/canvases/${encodeURIComponent(canvasId!)}/search-graphs/${encodeURIComponent(runId)}/close`, {
			method: "POST",
			body: "{}",
		});
		await reload.current();
	};
	const open = async (runId: string) => {
		await api(`/api/canvases/${encodeURIComponent(canvasId!)}/search-graphs/${encodeURIComponent(runId)}/open`, {
			method: "POST",
			body: "{}",
		});
		await reload.current();
		onOpen(runId);
	};
	const rename = async (runId: string, title: string) => {
		await api(`/api/canvases/${encodeURIComponent(canvasId!)}/search-graphs/${encodeURIComponent(runId)}`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		});
		await reload.current();
	};
	return { graphs, error, open, close, rename };
}
