import "./agent-input-controls.css";
import { ArrowUp, ChevronDown, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentPendingInput } from "./types";

export type AgentDelivery = "steer" | "followUp";

export function AgentInputControls({
	running,
	paused,
	disabled,
	stopping,
	delivery,
	onDelivery,
	onSend,
	onStop,
}: {
	running: boolean;
	paused: boolean;
	disabled: boolean;
	stopping: boolean;
	delivery: AgentDelivery;
	onDelivery(value: AgentDelivery): void;
	onSend(): void;
	onStop(): void;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const keydown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
				root.current?.querySelector<HTMLButtonElement>(".agent-delivery-toggle")?.focus();
			}
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", keydown);
		root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", keydown);
		};
	}, [open]);
	const label = paused ? "待发" : running ? (delivery === "steer" ? "插话" : "追加") : "发送";
	return (
		<div className="agent-input-actions" ref={root}>
			{running && (
				<button
					className="agent-input-stop"
					type="button"
					onClick={onStop}
					disabled={stopping}
					aria-label="停止生成"
					title="停止当前运行，保留待发消息"
				>
					<Square size={12} fill="currentColor" />
				</button>
			)}
			<div className="agent-send-split">
				<button
					className="agent-send-button"
					type="button"
					onClick={onSend}
					disabled={disabled}
					aria-label={paused ? "加入待发" : running ? (delivery === "steer" ? "插话纠正" : "追加任务") : "发送"}
					title={`${label} (Ctrl/Cmd + Enter)`}
				>
					<span>{label}</span>
					<ArrowUp size={14} />
				</button>
				<button
					className="agent-delivery-toggle"
					type="button"
					aria-label="选择发送方式"
					aria-expanded={open}
					aria-haspopup="menu"
					onClick={() => setOpen(!open)}
				>
					<ChevronDown size={13} />
				</button>
			</div>
			{open && (
				<div
					className="agent-delivery-menu"
					role="menu"
					aria-label="发送方式"
					onKeyDown={(e) => {
						if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
						e.preventDefault();
						const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
						const index = items.indexOf(document.activeElement as HTMLButtonElement);
						items[(index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
					}}
				>
					{(["steer", "followUp"] as const).map((mode) => (
						<button
							key={mode}
							type="button"
							role="menuitemradio"
							aria-checked={delivery === mode}
							onClick={() => {
								onDelivery(mode);
								setOpen(false);
							}}
						>
							<strong>{mode === "steer" ? "插话纠正" : "追加任务"}</strong>
							<small>
								{mode === "steer" ? "本轮工具结束后，尽早补充要求" : "当前任务完成后，再处理这条消息"}
							</small>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export function AgentPendingInputs({
	inputs,
	paused,
	busy,
	running,
	onResume,
	onClear,
}: {
	inputs: AgentPendingInput[];
	paused: boolean;
	busy: boolean;
	running: boolean;
	onResume(): void;
	onClear(): void;
}) {
	if (!inputs.length) return null;
	const uncertain = inputs.some((p) => p.status === "uncertain");
	return (
		<details className="agent-pending-inputs" open={paused || undefined}>
			<summary>
				{paused ? "待发消息已暂停" : "待处理消息"}
				<span>{inputs.length}</span>
			</summary>
			<ol>
				{inputs.map((item) => (
					<li key={item.id}>
						<span className="agent-pending-kind">
							{item.status === "uncertain"
								? "送达待确认"
								: item.status === "paused"
									? item.delivery === "steer"
										? "已暂停 · 插话"
										: "已暂停 · 追加"
									: item.delivery === "steer"
										? "插话待处理"
										: "完成后处理"}
						</span>
						<p>{item.content}</p>
						{Boolean(item.attachmentNames?.length) && <small>{item.attachmentNames?.join("、")}</small>}
					</li>
				))}
			</ol>
			{uncertain && (
				<p className="agent-queue-warning">请核对聊天记录；为避免重复执行，清空待发后再重新提交需要的任务。</p>
			)}
			<div className="agent-queue-actions">
				{paused && (
					<button type="button" disabled={busy || running || uncertain} onClick={onResume}>
						继续处理
					</button>
				)}
				<button type="button" disabled={busy} onClick={onClear}>
					清空待发
				</button>
			</div>
		</details>
	);
}
