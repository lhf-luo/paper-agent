import { X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type {
	CanvasEvidence,
	CanvasResearchRecord,
	CanvasResearchSettings,
} from "../../src/canvas/domain/canvas-research";
import { useResearchAction } from "./canvas-research-action";
import { type ResearchClient, type ResearchNode, researchClient, researchStatus } from "./canvas-research-api";
import { ResearchProposals } from "./canvas-research-proposals";
import { ResearchResults } from "./canvas-research-results";
import { ResearchSettings } from "./canvas-research-settings";
import { useResearchRecords } from "./canvas-research-state";
import "./canvas-research.css";

interface PanelProps {
	canvasId: string;

	sessionId?: string;
	agentNodeId?: string;
	nodes: ResearchNode[];
	onClose: () => void;
	onRead: (e: CanvasEvidence) => void;
	onStart?: () => void;
	apply: (id: string, selected: string[], undo?: boolean) => Promise<void>;
	beforePreview: () => Promise<boolean>;
}
type Records = ReturnType<typeof useResearchRecords>;
const tabs = [
	["settings", "目标"],
	["coverage", "覆盖"],
	["matrix", "方法矩阵"],
	["relations", "关系建议"],
	["proposals", "变更预览"],
] as const;
function TabBar({ tab, setTab, records }: { tab: string; setTab: (t: string) => void; records: Records }) {
	return (
		<nav aria-label="研究功能">
			{tabs.map(([id, label]) => (
				<button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
					{label}
					{id === "proposals" && records.proposals.some((p) => p.value.status === "pending") ? " ·" : ""}
				</button>
			))}
		</nav>
	);
}
function ResearchContent({
	props,
	client,
	records,
	tab,
	adopt,
}: {
	props: PanelProps;
	client: ResearchClient;
	records: Records;
	tab: string;
	adopt: (q: string) => void;
}) {
	return (
		<>
			<label>
				分析记录
				<select value={records.runId} onChange={(e) => records.setRunId(e.target.value)}>
					<option value="">选择分析</option>
					{records.analyses.map((a) => (
						<option key={a.id} value={a.id}>
							{new Date(a.updatedAt).toLocaleString()} · {researchStatus[a.value.status]} ·{" "}
							{a.value.paperIds.length} 篇
						</option>
					))}
				</select>
			</label>
			{["coverage", "matrix", "relations"].includes(tab) && (
				<ResearchResults
					run={records.run}
					tab={tab}
					nodes={props.nodes}
					onRead={props.onRead}
					onPage={records.setOffset}
					onAdopt={adopt}
				/>
			)}
			{tab === "proposals" && (
				<ResearchProposals
					client={client}
					records={records.proposals}
					nodes={props.nodes}
					run={records.run}
					apply={async (...args) => {
						await props.apply(...args);
						records.refresh();
					}}
					refresh={records.refresh}
				/>
			)}
		</>
	);
}
export function CanvasResearchPanel(props: PanelProps) {
	const { canvasId, sessionId, beforePreview } = props;
	const beforePreviewRef = useRef(beforePreview);
	beforePreviewRef.current = beforePreview;
	const client = useMemo(() => researchClient(canvasId, sessionId), [canvasId, sessionId]);
	const records = useResearchRecords(client),
		action = useResearchAction();
	const [tab, setTab] = useState("settings"),
		[settingsKey, setSettingsKey] = useState(0);
	const adopt = (question: string) =>
		void action.perform(async () => {
			const current = await client.get<CanvasResearchRecord<CanvasResearchSettings>>("settings");
			await client.post("settings", {
				settings: { ...current.value, question },
				expectedRevision: current.revision,
			});
			setSettingsKey((k) => k + 1);
			setTab("settings");
			records.refresh();
		});
	const previewClient = useMemo(
		() => ({
			...client,
			async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
				if (path === "proposals" && !(await beforePreviewRef.current())) throw new Error("请先处理画布保存冲突");
				return client.post<T>(path, body);
			},
		}),
		[client],
	);
	return (
		<aside className="canvas-research-panel" aria-label="画布研究">
			<header>
				<strong>画布研究</strong>
				<button type="button" onClick={props.onClose} aria-label="关闭画布研究">
					<X size={18} />
				</button>
			</header>
			<TabBar tab={tab} setTab={setTab} records={records} />
			<div className="canvas-research-panel-body">
				{(records.error || action.error) && <p role="alert">{records.error || action.error}</p>}
				{tab === "settings" ? (
					<ResearchSettings
						key={settingsKey}
						client={client}
						nodes={props.nodes}
						agentNodeId={props.agentNodeId}
						onSaved={records.refresh}
						onStart={props.onStart}
					/>
				) : (
					<ResearchContent props={props} client={previewClient} records={records} tab={tab} adopt={adopt} />
				)}
			</div>
		</aside>
	);
}
