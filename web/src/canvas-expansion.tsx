import { useEffect, useRef } from "react";
import { JobProgress } from "./components";
import { useExpansion, type ExpansionProps } from "./use-canvas-expansion";
import type { PaperRecord } from "./types";
import "./canvas-expansion.css";
type Model = ReturnType<typeof useExpansion>;
function ExpansionFields({ m, papers }: { m: Model; papers: PaperRecord[] }) {
	return (
		<fieldset disabled={m.running}>
			<label>
				起点论文
				<select
					value={m.paperId}
					onChange={(e) => {
						m.setPaperId(e.target.value);
						m.setAuthor("");
					}}
					required
				>
					{papers.map((p) => (
						<option key={p.id} value={p.id}>
							{p.title}
						</option>
					))}
				</select>
			</label>
			<label>
				扩展类型
				<select value={m.kind} onChange={(e) => m.setKind(e.target.value as "citation" | "author")}>
					<option value="citation">论文引用扩展</option>
					<option value="author">作者论文扩展（API）</option>
				</select>
			</label>
			<ExpansionSource m={m} />
			<ExpansionYears m={m} />
			<label>
				{m.kind === "citation" ? "邻居数量上限（起点不占配额）" : "每个提供商的结果上限"}
				<input
					type="number"
					required
					min={1}
					max={100}
					value={m.limit}
					onChange={(e) => m.setLimit(Number(e.target.value))}
				/>
			</label>
		</fieldset>
	);
}
export function CanvasExpansion(props: ExpansionProps) {
	const m = useExpansion(props),
		root = useRef<HTMLElement>(null);
	useEffect(() => {
		root.current?.focus();
	}, []);
	return (
		<div className="canvas-expansion-backdrop">
			<section
				ref={root}
				tabIndex={-1}
				className="canvas-expansion"
				role="dialog"
				aria-modal="true"
				aria-label="新建扩展图谱"
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						props.onClose();
					}
				}}
			>
				<header>
					<h3>新建扩展图谱</h3>
					<button type="button" aria-label="关闭扩展面板" onClick={props.onClose}>
						×
					</button>
				</header>
				{!props.papers.length ? (
					<p>请先从个人库向画布添加一篇论文，再生成引用或作者图谱。</p>
				) : (
					<ExpansionForm m={m} papers={props.papers} onClose={props.onClose} />
				)}
			</section>
		</div>
	);
}

function ExpansionSource({ m }: { m: Model }) {
	return (
		<>
			{m.kind === "citation" ? (
				<label>
					扩展方向
					<select value={m.direction} onChange={(e) => m.setDirection(e.target.value)}>
						<option value="both">参考文献与施引论文</option>
						<option value="references">参考文献（它引用的论文）</option>
						<option value="citations">施引论文（引用它的论文）</option>
					</select>
				</label>
			) : (
				<label>
					作者
					<select
						value={m.author || m.paper?.authors[0] || ""}
						required
						onChange={(e) => m.setAuthor(e.target.value)}
					>
						{[...new Set(m.paper?.authors ?? [])].map((a) => (
							<option key={a} value={a}>
								{a}
							</option>
						))}
					</select>
				</label>
			)}
		</>
	);
}

function ExpansionYears({ m }: { m: Model }) {
	return (
		<div className="canvas-expansion-years">
			<label>
				开始年份
				<input
					type="number"
					min={1000}
					max={9999}
					placeholder="不限"
					value={m.from}
					onChange={(e) => m.setFrom(e.target.value)}
				/>
			</label>
			<label>
				结束年份
				<input
					type="number"
					min={m.from || 1000}
					max={9999}
					placeholder="不限"
					value={m.to}
					onChange={(e) => m.setTo(e.target.value)}
				/>
			</label>
		</div>
	);
}

function ExpansionForm({ m, papers, onClose }: { m: Model; papers: PaperRecord[]; onClose: () => void }) {
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void m.start();
			}}
		>
			<ExpansionFields m={m} papers={papers} />
			<p>直接查询文献来源，完成后打开图谱。论文保存在搜索记录中，入库需另行选择。</p>
			{m.kind === "author" && (
				<p>使用 OpenAlex、Semantic Scholar 和 DBLP。Google Scholar 主页采集继续在 Agent 中通过浏览器执行。</p>
			)}
			<JobProgress job={m.job} />
			{m.job?.error && <p role="alert">{m.job.error}</p>}
			{m.error && <p role="alert">{m.error}</p>}
			<footer>
				{m.running ? (
					<button type="button" onClick={() => void m.cancel()} disabled={!m.job}>
						取消扩展
					</button>
				) : m.job ? (
					<button type="button" onClick={m.again}>
						重新设置扩展
					</button>
				) : (
					<button type="submit" disabled={m.running || !m.paperId}>
						开始扩展并生成图谱
					</button>
				)}
				<button type="button" onClick={onClose}>
					{m.running ? "后台运行，关闭面板" : "关闭"}
				</button>
			</footer>
		</form>
	);
}
