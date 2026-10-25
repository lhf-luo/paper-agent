import { useEffect, useRef } from "react";
import type { SelectedCanvasPaper } from "./canvas-paper-batch";

export function CanvasPaperCollectionCheckbox({
	label,
	ids,
	selected,
	disabled,
	onToggle,
}: {
	label: string;
	ids?: string[];
	selected: ReadonlyMap<string, SelectedCanvasPaper>;
	disabled: boolean;
	onToggle: (checked: boolean) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const count = ids?.reduce((total, id) => total + Number(selected.has(id)), 0) ?? 0;
	const checked = Boolean(ids?.length && count === ids.length);
	useEffect(() => {
		if (input.current) input.current.indeterminate = count > 0 && !checked;
	}, [count, checked]);
	return (
		<input
			ref={input}
			type="checkbox"
			className="research-canvas-picker-category-check"
			checked={checked}
			disabled={disabled || !ids?.length}
			aria-label={`选择${label}中的全部论文`}
			title={ids ? `${label}：${ids.length} 篇，不受搜索词影响` : "正在加载分类论文"}
			onChange={() => onToggle(!checked)}
		/>
	);
}
