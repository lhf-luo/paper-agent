import { useState } from "react";
import { api } from "./api";
import type { GraphRelation } from "../../src/canvas/domain/search-graph-relations";
import type { GraphEdge } from "./canvas-graph-types";
export function SearchGraphEvidence({
	base,
	nodeId,
	relations,
}: {
	base: string;
	nodeId: string;
	relations: GraphEdge[];
}) {
	const [evidence, setEvidence] = useState<GraphRelation>(),
		[error, setError] = useState(""),
		[limit, setLimit] = useState(12);
	const adjacent = relations.filter((e) => e.from === nodeId || e.to === nodeId);
	const load = async (id: string) => {
		setError("");
		try {
			setEvidence(await api<GraphRelation>(`${base}/evidence?edgeId=${encodeURIComponent(id)}`));
		} catch (e) {
			setError(String(e));
		}
	};
	return (
		<details className="graph-relation-evidence">
			<summary>引文关系依据（{adjacent.length}）</summary>
			{adjacent.slice(0, limit).map((e) => (
				<button key={e.id} type="button" onClick={() => void load(e.id)}>
					{e.kind === "citation" ? (e.from === nodeId ? "引用 → " : "被引用 ← ") : "引文关联 · "}
					{e.from === nodeId ? e.to : e.from} · {(e.score ?? 0).toFixed(3)}
				</button>
			))}
			{adjacent.length > limit && (
				<button type="button" onClick={() => setLimit((v) => v + 12)}>
					更多关系
				</button>
			)}
			{evidence && (
				<div>
					<p>
						{evidence.label} · 文献耦合 {evidence.coupling?.toFixed(3) ?? "未知/不适用"} · 共被引{" "}
						{evidence.cocitation?.toFixed(3) ?? "未知/不适用"}
					</p>
					<p>参考证据：{evidence.evidence.references.join("、") || "无"}</p>
					<p>施引证据：{evidence.evidence.citations.join("、") || "无"}</p>
					<small>
						来源：{evidence.evidence.sources.join("、")} · {evidence.evidence.collectedAt.join("、")}
					</small>
					<small>双方参考/施引覆盖：{evidence.evidence.coverage.join(" / ")}</small>
				</div>
			)}
			{error && <p role="alert">{error}</p>}
		</details>
	);
}
