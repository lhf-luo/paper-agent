import { useCallback, useEffect, useRef, useState, type RefObject, type PointerEvent } from "react";
import { fitGraphPositions, type CanvasGraphState } from "./canvas-graph-types";
function useRafGraphState(state: CanvasGraphState, onChange: (s: CanvasGraphState) => void) {
	const latest = useRef(state),
		emit = useRef(onChange),
		frame = useRef(0),
		pending = useRef<CanvasGraphState | undefined>(undefined);
	latest.current = state;
	emit.current = onChange;
	const flush = useCallback(() => {
		if (frame.current) cancelAnimationFrame(frame.current);
		frame.current = 0;
		if (pending.current) {
			emit.current(pending.current);
			pending.current = undefined;
		}
	}, []);
	const schedule = useCallback(
		(next: CanvasGraphState) => {
			latest.current = next;
			pending.current = next;
			if (!frame.current) frame.current = requestAnimationFrame(flush);
		},
		[flush],
	);
	return { latest, schedule, flush };
}
function useViewport(svg: RefObject<SVGSVGElement | null>, control: ReturnType<typeof useRafGraphState>) {
	const [size, setSize] = useState({ width: 0, height: 0 });
	const { latest, schedule, flush } = control;
	useEffect(() => {
		const element = svg.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) =>
			setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
		);
		observer.observe(element);
		const wheel = (e: WheelEvent) => {
			e.preventDefault();
			const s = latest.current,
				rect = element.getBoundingClientRect();
			const x = e.clientX - rect.left - rect.width / 2,
				y = e.clientY - rect.top - rect.height / 2;
			const scale = Math.max(0.1, Math.min(5, s.viewport.scale * Math.exp(-e.deltaY * 0.0015))),
				ratio = scale / s.viewport.scale;
			schedule({
				...s,
				needsFit: false,
				viewport: { scale, x: x - (x - s.viewport.x) * ratio, y: y - (y - s.viewport.y) * ratio },
			});
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => {
			observer.disconnect();
			element.removeEventListener("wheel", wheel);
			flush();
		};
	}, [svg, latest, schedule, flush]);
	return size;
}
interface Drag {
	id?: string;
	x: number;
	y: number;
	initial: CanvasGraphState;
	moved: boolean;
}
function dragState(d: Drag, dx: number, dy: number): CanvasGraphState {
	const s = d.initial;
	if (d.id && s.positions[d.id])
		return {
			...s,
			needsFit: false,
			manualPins: [...new Set([...(s.manualPins ?? []), d.id])],
			positions: {
				...s.positions,
				[d.id]: { x: s.positions[d.id].x + dx / s.viewport.scale, y: s.positions[d.id].y + dy / s.viewport.scale },
			},
		};
	return { ...s, needsFit: false, viewport: { ...s.viewport, x: s.viewport.x + dx, y: s.viewport.y + dy } };
}
function useDrag(control: ReturnType<typeof useRafGraphState>, onSelect: (id: string) => void) {
	const drag = useRef<Drag | undefined>(undefined),
		{ latest, schedule, flush } = control;
	return {
		onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
			if (e.button !== 0) return;
			const id = (e.target as Element).closest("[data-node]")?.getAttribute("data-node") ?? undefined;
			drag.current = { id, x: e.clientX, y: e.clientY, initial: latest.current, moved: false };
			e.currentTarget.setPointerCapture(e.pointerId);
		},
		onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
			const d = drag.current;
			if (!d) return;
			const dx = e.clientX - d.x,
				dy = e.clientY - d.y;
			d.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
			if (d.moved) schedule(dragState(d, dx, dy));
		},
		onPointerUp: (e: PointerEvent<SVGSVGElement>) => {
			flush();
			const d = drag.current;
			drag.current = undefined;
			if (d?.id && !d.moved) onSelect(d.id);
			if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		},
		onPointerCancel: () => {
			flush();
			drag.current = undefined;
		},
	};
}
export function useNetworkInteraction(
	svg: RefObject<SVGSVGElement | null>,
	state: CanvasGraphState,
	onChange: (s: CanvasGraphState) => void,
	onSelect: (id: string) => void,
) {
	const control = useRafGraphState(state, onChange),
		size = useViewport(svg, control),
		events = useDrag(control, onSelect);
	useEffect(() => {
		if (state.needsFit && size.width > 0 && size.height > 0 && Object.keys(state.positions).length)
			onChange({ ...state, needsFit: false, viewport: fitGraphPositions(state.positions, size.width, size.height) });
	}, [state, size, onChange]);
	return { size, events };
}
