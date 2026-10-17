import { useEffect, useState } from "react";
import type {
	CanvasResearchContext,
	CanvasResearchRecord,
	CanvasResearchSettings,
} from "../../src/canvas/domain/canvas-research";
import { useResearchAction } from "./canvas-research-action";
import type { ResearchClient, ResearchNode } from "./canvas-research-api";

type Update = (key: keyof CanvasResearchSettings, value: string | number | string[]) => void;
const nodeTypeNames: Record<string, string> = {
	paper: "论文",
	note: "笔记",
	text: "文本",
	author: "作者",
	team: "团队",
	agent: "Agent 对话",
};
function useSettings(client: ResearchClient, agentNodeId?: string) {
	const [record, setRecord] = useState<CanvasResearchRecord<CanvasResearchSettings>>();
	const [settings, setSettings] = useState<CanvasResearchSettings>();
	const [scope, setScope] = useState<CanvasResearchContext>({ scope: "canvas", selectedNodeIds: [] });
	const action = useResearchAction();
	useEffect(() => {
		let active = true;
		void action.perform(async () => {
			const [r, s] = await Promise.all([
				client.get<CanvasResearchRecord<CanvasResearchSettings>>("settings"),
				client.get<CanvasResearchContext>("scope"),
			]);
			if (active) {
				setRecord(r);
				setSettings(r.value);
				setScope(s);
			}
		});
		return () => {
			active = false;
		};
	}, [client, action.perform]);
	const update: Update = (key, value) => setSettings((s) => s && { ...s, [key]: value });
	const save = () =>
		action.perform(async () => {
			if (!record || !settings) throw new Error("研究设置尚未加载");
			const next = await client.post<CanvasResearchRecord<CanvasResearchSettings>>("settings", {
				settings,
				expectedRevision: record.revision,
			});
			setRecord(next);
			setSettings(next.value);
			await client.post("scope", { scope: { ...scope, agentNodeId } });
		});
	return { settings, scope, setScope, update, save, ...action };
}
function GoalFields({ settings: s, update }: { settings: CanvasResearchSettings; update: Update }) {
	return (
		<>
			<label>
				研究问题
				<textarea
					value={s.question}
					onChange={(e) => update("question", e.target.value)}
					placeholder="希望这些论文共同回答什么问题？"
				/>
			</label>
			<label>
				应用场景
				<input value={s.scenario} onChange={(e) => update("scenario", e.target.value)} />
			</label>
			<div className="canvas-research-fields">
				{(
					[
						["include", "纳入条件"],
						["exclude", "排除条件"],
					] as const
				).map(([key, label]) => (
					<label key={key}>
						{label}
						<textarea value={s[key]} onChange={(e) => update(key, e.target.value)} />
					</label>
				))}
			</div>
			<div className="canvas-research-fields">
				{(
					[
						["dateFrom", "起始日期"],
						["dateTo", "截止日期"],
					] as const
				).map(([key, label]) => (
					<label key={key}>
						{label}
						<input type="date" value={s[key]} onChange={(e) => update(key, e.target.value)} />
					</label>
				))}
			</div>
			<label>
				比较维度（每行一个）
				<textarea
					value={s.dimensions.join("\n")}
					onChange={(e) => update("dimensions", e.target.value.split("\n"))}
				/>
			</label>
		</>
	);
}
function BudgetFields({ settings: s, update }: { settings: CanvasResearchSettings; update: Update }) {
	return (
		<>
			<label>
				阅读方式
				<select value={s.readingDepth} onChange={(e) => update("readingDepth", e.target.value)}>
					<option value="layered">全量初筛与代表性取证</option>
					<option value="method">逐篇方法精读</option>
					<option value="full">逐篇全文研究</option>
				</select>
			</label>
			<div className="canvas-research-fields">
				{(
					[
						["readingBudget", "新深入论文数", 500],
						["queryBudget", "查询变体", 12],
						["searchCallBudget", "外部检索调用", 20],
						["resultsPerProvider", "每提供商结果数", 100],
					] as const
				).map(([key, label, max]) => (
					<label key={key}>
						{label}
						<input
							type="number"
							min={1}
							max={max}
							value={s[key]}
							onChange={(e) => update(key, Number(e.target.value))}
						/>
					</label>
				))}
			</div>
		</>
	);
}
function ScopeFields({
	scope,
	setScope,
	nodes,
	agentNodeId,
	disabled,
}: {
	scope: CanvasResearchContext;
	setScope: (s: CanvasResearchContext) => void;
	nodes: ResearchNode[];
	agentNodeId?: string;
	disabled: boolean;
}) {
	return (
		<>
			<label>
				本会话视野
				<select
					value={scope.scope}
					disabled={disabled}
					onChange={(e) => setScope({ ...scope, scope: e.target.value as CanvasResearchContext["scope"] })}
				>
					<option value="canvas">整张画布</option>
					<option value="selected">勾选节点</option>
					<option value="neighbors" disabled={!agentNodeId}>
						当前 Agent 的直接邻居
					</option>
				</select>
			</label>
			{scope.scope === "selected" && (
				<div className="canvas-research-node-checks">
					{nodes.map((n) => (
						<label key={n.id}>
							<input
								type="checkbox"
								checked={scope.selectedNodeIds.includes(n.id)}
								disabled={disabled}
								onChange={(e) =>
									setScope({
										...scope,
										selectedNodeIds: e.target.checked
											? [...scope.selectedNodeIds, n.id]
											: scope.selectedNodeIds.filter((id) => id !== n.id),
									})
								}
							/>
							{n.alias || nodeTypeNames[n.kind] || n.kind} · {n.title}
						</label>
					))}
				</div>
			)}
		</>
	);
}
export function ResearchSettings({
	client,
	nodes,
	agentNodeId,
	onSaved,
	onStart,
}: {
	client: ResearchClient;
	nodes: ResearchNode[];
	agentNodeId?: string;
	onSaved: () => void;
	onStart?: () => void;
}) {
	const state = useSettings(client, agentNodeId);
	const save = async (start = false) => {
		if (await state.save()) {
			onSaved();
			if (start) onStart?.();
		}
	};
	if (!state.settings) return <output>{state.error || "正在加载研究设置…"}</output>;
	return (
		<form
			className="canvas-research-form"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<GoalFields settings={state.settings} update={state.update} />
			<BudgetFields settings={state.settings} update={state.update} />
			<ScopeFields
				scope={state.scope}
				setScope={state.setScope}
				nodes={nodes}
				agentNodeId={agentNodeId}
				disabled={!onStart}
			/>
			{!onStart && <p>打开本画布的 Agent 会话后，可以开始或继续研究。</p>}
			{state.error && <p role="alert">{state.error}</p>}
			<div className="button-row">
				<button type="submit" className="button secondary" disabled={state.busy}>
					保存设置
				</button>
				{onStart && (
					<button type="button" className="button" disabled={state.busy} onClick={() => void save(true)}>
						保存并准备研究任务
					</button>
				)}
			</div>
		</form>
	);
}
