import { useEffect, useRef, useState, type RefObject } from "react";
import type { CanvasGraphState } from "./canvas-graph-types";
export function useGraphFocus(
	initialFocus: string | undefined,
	state: CanvasGraphState | undefined,
	change: (s: CanvasGraphState) => void,
) {
	const [focus, setFocus] = useState(initialFocus),
		restored = useRef(false);
	useEffect(() => {
		if (!state || restored.current) return;
		restored.current = true;
		if (!initialFocus) setFocus(state.focusId);
	}, [state, initialFocus]);
	useEffect(() => {
		if (initialFocus) setFocus(initialFocus);
	}, [initialFocus]);
	useEffect(() => {
		if (!state || !restored.current || state.focusId === focus) return;
		change({ ...state, focusId: focus });
	}, [focus, state, change]);
	return [focus, setFocus] as const;
}
export function useGraphSelection(
	initialSelection: string | undefined,
	initialFocus: string | undefined,
	state: CanvasGraphState | undefined,
	change: (s: CanvasGraphState) => void,
	list: RefObject<HTMLDivElement | null>,
) {
	const [selected, setSelected] = useState(initialSelection ?? initialFocus),
		applied = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (initialSelection) setSelected(initialSelection);
	}, [initialSelection]);
	useEffect(() => {
		if (initialFocus) setSelected(initialFocus);
	}, [initialFocus]);
	useEffect(() => {
		if (!state || !selected || applied.current === selected || !state.positions[selected]) return;
		applied.current = selected;
		const p = state.positions[selected];
        if (state.needsFit) return; // Initial fit must include every component; only explicit later selections recenter.
		change({
			...state,
			viewport: { ...state.viewport, x: -p.x * state.viewport.scale, y: -p.y * state.viewport.scale },
		});
		list.current?.querySelector<HTMLElement>(`[data-paper="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected, state, change, list]);
	return [selected, setSelected] as const;
}
