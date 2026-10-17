import { Trash2 } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef } from "react";
import type { CanvasGroup } from "../../src/canvas/domain/research-canvas";

interface RegionProps {
	group: CanvasGroup;
	scale: number;
	onChange: (group: CanvasGroup) => void;
	onRemove: (id: string) => void;
}
function trackDrag(
	element: HTMLDivElement | null,
	group: CanvasGroup,
	scale: number,
	event: ReactPointerEvent,
	resize: boolean,
	commit: (g: CanvasGroup) => void,
) {
	const x = event.clientX,
		y = event.clientY;
	let next = group,
		frame = 0;
	const paint = () => {
		frame = 0;
		if (element)
			Object.assign(element.style, {
				left: `${next.x}px`,
				top: `${next.y}px`,
				width: `${next.width}px`,
				height: `${next.height}px`,
			});
	};
	const move = (e: PointerEvent) => {
		const dx = (e.clientX - x) / scale,
			dy = (e.clientY - y) / scale;
		next = resize
			? { ...group, width: Math.max(160, group.width + dx), height: Math.max(80, group.height + dy) }
			: { ...group, x: group.x + dx, y: group.y + dy };
		if (!frame) frame = requestAnimationFrame(paint);
	};
	const stop = () => {
		cleanup();
		if (next !== group) commit(next);
	};
	const cleanup = () => {
		cancelAnimationFrame(frame);
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
	return cleanup;
}
function GroupTitle({ group, onChange, onRemove }: Omit<RegionProps, "scale">) {
	return (
		<>
			<input
				aria-label="分组名称"
				defaultValue={group.title}
				key={group.title}
				maxLength={120}
				onPointerDown={(e) => e.stopPropagation()}
				onBlur={(e) => {
					const title = e.target.value.trim();
					if (title && title !== group.title) onChange({ ...group, title });
					else e.target.value = group.title;
				}}
			/>
			<button
				type="button"
				title="移除分组，保留节点"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={(e) => {
					e.stopPropagation();
					onRemove(group.id);
				}}
			>
				<Trash2 size={14} />
			</button>
		</>
	);
}
function GroupResize({
	group,
	onChange,
	onPointerDown,
}: {
	group: CanvasGroup;
	onChange: RegionProps["onChange"];
	onPointerDown: (e: ReactPointerEvent) => void;
}) {
	return (
		<button
			type="button"
			className="research-canvas-group-resize"
			aria-label={`调整分组 ${group.title} 大小`}
			onPointerDown={onPointerDown}
			onKeyDown={(e) => {
				const sizes = { ArrowRight: [20, 0], ArrowLeft: [-20, 0], ArrowDown: [0, 20], ArrowUp: [0, -20] }[e.key];
				if (sizes) {
					e.preventDefault();
					e.stopPropagation();
					onChange({
						...group,
						width: Math.max(160, group.width + sizes[0]),
						height: Math.max(80, group.height + sizes[1]),
					});
				}
			}}
		/>
	);
}
function GroupRegion(props: RegionProps) {
	const element = useRef<HTMLDivElement>(null),
		cleanup = useRef<() => void>(() => {});
	useEffect(() => () => cleanup.current(), []);
	const { group, scale, onChange } = props;
	const start = (e: ReactPointerEvent, resize: boolean) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		cleanup.current();
		cleanup.current = trackDrag(element.current, group, scale, e, resize, onChange);
	};
	return (
		<div
			className="research-canvas-group"
			ref={element}
			style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
		>
			<header onPointerDown={(e) => start(e, false)}>
				<GroupTitle {...props} />
			</header>
			<GroupResize group={group} onChange={onChange} onPointerDown={(e) => start(e, true)} />
		</div>
	);
}
export function CanvasGroups(props: Omit<RegionProps, "group"> & { groups: CanvasGroup[] }) {
	return props.groups.map((group) => <GroupRegion key={group.id} {...props} group={group} />);
}
