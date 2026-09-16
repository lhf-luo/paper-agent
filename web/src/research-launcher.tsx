import type { LucideIcon } from "lucide-react";
import {
	AlertCircle,
	BookOpen,
	Check,
	CheckCircle2,
	Cpu,
	Download,
	FileText,
	FlaskConical,
	Layers,
	Loader2,
	Search,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { AccessibleModal } from "./components";
import type { AutomatedResearchDepth, PaperVersionView } from "./types";

export interface AutomatedResearchLaunchInput {
	paperId: string;
	namespace: string;
	depth: AutomatedResearchDepth;
	researchQuestion?: string;
	discoverArtifacts: boolean;
}

interface DepthOption {
	id: AutomatedResearchDepth;
	label: string;
	badge: string;
	icon: LucideIcon;
	description: string;
	bestFor: string;
}

const depthOptions: DepthOption[] = [
	{
		id: "quick",
		label: "快速略读",
		badge: "初筛 · ~1-2分钟",
		icon: BookOpen,
		description: "提取研究问题、核心方法、主要结论与明显局限，快速判断学术价值，不虚构全文细节。",
		bestFor: "适合快速排查是否值得深入精读",
	},
	{
		id: "methods",
		label: "方法精读",
		badge: "推荐 · 深度剖析",
		icon: Cpu,
		description: "重点剖析算法细节、架构实现路线、关键对比实验与直接支撑方法有效性的图表。",
		bestFor: "适合深入吃透算法与实现方案",
	},
	{
		id: "full",
		label: "全文研究",
		badge: "全景论证 · 证据链",
		icon: Layers,
		description: "通读覆盖全部物理页，系统梳理背景问题、论证链条、实验数据、讨论与未解决局限。",
		bestFor: "适合重要代表作与领域综述",
	},
	{
		id: "reproduce",
		label: "复现准备",
		badge: "开源物料 · 复现方案",
		icon: FlaskConical,
		description: "在全文研究基础上，全面检索公开发布的代码、权重与数据集，生成可执行的实验计划。",
		bestFor: "适合准备动手复现与二次开发",
	},
];

/** 各深度对应的默认思考强度, 与后端 automatedResearchThinkingLevel 保持一致。 */
const depthThinkingLabels: Record<AutomatedResearchDepth, string> = {
	quick: "低 (low)",
	methods: "中 (medium)",
	full: "高 (high)",
	reproduce: "高 (high)",
};

export function ResearchLauncher({
	paperId,
	paperTitle,
	versions,
	namespace,
	busy,
	onPreparePdf,
	onStart,
}: {
	paperId: string;
	paperTitle?: string;
	versions: PaperVersionView[];
	namespace: string;
	busy: boolean;
	onPreparePdf: () => Promise<void>;
	onStart: (input: AutomatedResearchLaunchInput) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [depth, setDepth] = useState<AutomatedResearchDepth>("methods");
	const [question, setQuestion] = useState("");
	const [discoverArtifacts, setDiscoverArtifacts] = useState(true);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState("");
	const version = [...versions]
		.filter((candidate) => candidate.versionKind !== "translation")
		.sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt))[0];

	const start = async () => {
		setStarting(true);
		setError("");
		try {
			await onStart({
				paperId,
				namespace,
				depth,
				researchQuestion: question.trim() || undefined,
				discoverArtifacts,
			});
			setOpen(false);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setStarting(false);
		}
	};

	return (
		<div className="research-launcher">
			<button
				className="button primary continue-research-btn"
				type="button"
				onClick={() => setOpen(true)}
				title="启动 AI 深度研究向导"
			>
				<Sparkles size={16} />
				<span>一键继续研究</span>
			</button>

			{open && (
				<AccessibleModal
					title="自动推进论文研究 · Guided Research"
					description="让 AI 自动深度研读全文、抽取关键论证与图表证据，沉淀为可回溯的研究记忆"
					onClose={() => setOpen(false)}
					maxWidth={760}
					className="research-launcher-modal"
				>
					<div className="research-modal-content">
						{paperTitle && (
							<div className="research-target-paper" title={paperTitle}>
								<span className="research-target-label">研读目标</span>
								<p className="research-target-title">{paperTitle}</p>
							</div>
						)}

						<div className="beginner-callout">
							<div className="beginner-callout-icon">
								<Sparkles size={18} />
							</div>
							<div className="beginner-callout-content">
								<strong>无需预先掌握复杂学术术语</strong>
								<p>
									选择您期望的研读深度即可。AI
									会逐页精读、解释专业术语、精准标注对应物理页码，并将需要您核验决定的事项归纳在报告末尾。
								</p>
							</div>
						</div>

						<div className="research-form-section">
							<div className="research-section-header">
								<span className="research-section-title">选择研究深度</span>
								<span className="research-section-hint">按需分配 AI 算力与研读精细度</span>
							</div>

							<div className="research-depth-grid" role="radiogroup" aria-label="研究深度选择">
								{depthOptions.map((option) => {
									const isSelected = depth === option.id;
									const Icon = option.icon;
									return (
										<button
											type="button"
											key={option.id}
											className={`research-depth-card${isSelected ? " is-selected" : ""}`}
											onClick={() => setDepth(option.id)}
											aria-pressed={isSelected}
										>
											<div className="research-depth-card-top">
												<div className="research-depth-card-identity">
													<div className="research-depth-icon-wrapper">
														<Icon size={16} />
													</div>
													<div className="research-depth-title-wrap">
														<span className="research-depth-label">{option.label}</span>
														<span className="research-depth-badge">{option.badge}</span>
													</div>
												</div>
												<div className="research-depth-radio-indicator" aria-hidden="true">
													{isSelected && <Check size={12} strokeWidth={3} />}
												</div>
											</div>
											<p className="research-depth-desc">{option.description}</p>
											<div className="research-depth-footer">
												<span className="research-depth-bestfor">{option.bestFor}</span>
											</div>
										</button>
									);
								})}
								</div>
								<p className="research-field-hint">
									本深度将使用思考强度「{depthThinkingLabels[depth]}」，启动后可在 Agent 对话中随时调整。
								</p>
							</div>

							<div className="research-form-section">
								<div className="research-section-header">
									<label htmlFor={`research-question-${paperId}`} className="research-section-title">
										你想重点弄清楚什么问题？
									</label>
								<span className="research-optional-badge">可选</span>
							</div>
							<p className="research-field-hint">
								可指定关注的模型模块、特定对比实验或具体学术疑问。留空则展开全面通用研究。
							</p>
							<textarea
								id={`research-question-${paperId}`}
								className="research-textarea"
								rows={3}
								value={question}
								onChange={(event) => setQuestion(event.target.value)}
								placeholder="例如：这个方法为什么能发现传统测试遗漏的数据库逻辑错误？核心算法在什么场景下会失效？如果留空，AI 会自动做通用全面研究。"
							/>
						</div>

						<button
							type="button"
							className={`research-artifacts-toggle-card${discoverArtifacts ? " is-active" : ""}`}
							onClick={() => setDiscoverArtifacts((prev) => !prev)}
							aria-pressed={discoverArtifacts}
						>
							<div className="research-toggle-checkbox-visual" aria-hidden="true">
								{discoverArtifacts && <Check size={13} strokeWidth={3} />}
							</div>
							<div className="research-artifacts-toggle-text">
								<div className="research-artifacts-toggle-title">
									<span>只读检索关联代码、数据集与开源链接</span>
									<span className="research-safe-pill">
										<ShieldCheck size={12} />
										安全只读
									</span>
								</div>
								<p className="research-artifacts-toggle-desc">
									仅定位论文提及的 GitHub、HuggingFace 等公开链接并整理清单，不会自动下载、安装或运行外部代码。
								</p>
							</div>
						</button>

						{version ? (
							<div className="research-prerequisite-card is-ready">
								<div className="research-prerequisite-icon">
									<CheckCircle2 size={18} />
								</div>
								<div className="research-prerequisite-content">
									<div className="research-prerequisite-title-row">
										<strong>本地 PDF 原文已就绪</strong>
										<span className="research-status-tag ready">可直接解析</span>
									</div>
									<div className="research-prerequisite-meta">
										<span>{Math.round(version.bytes / 1024)} KB</span>
										<span className="meta-dot">·</span>
										<code>SHA-256 {version.sha256.slice(0, 12)}…</code>
									</div>
								</div>
							</div>
						) : (
							<div className="research-prerequisite-card is-missing">
								<div className="research-prerequisite-icon">
									<AlertCircle size={18} />
								</div>
								<div className="research-prerequisite-content">
									<div className="research-prerequisite-title-row">
										<strong>需要先获取论文原文 PDF</strong>
										<span className="research-status-tag warning">未就绪</span>
									</div>
									<p className="research-prerequisite-tip">
										当前个人库中仅有检索元数据。AI 需要分析真实的物理排版页和图表才能保证研究准确度。
									</p>
									<button
										className="button secondary sm research-download-btn"
										type="button"
										disabled={busy}
										onClick={() => void onPreparePdf()}
									>
										<Download size={14} />
										<span>立即下载 PDF 原文</span>
									</button>
								</div>
							</div>
						)}

						<div className="research-boundaries-panel">
							<div className="research-boundary-item">
								<div className="boundary-icon ai">
									<Search size={14} />
								</div>
								<div className="boundary-text">
									<strong>AI 自动推进</strong>
									<span>全篇研读、图表数据定位、开源物料检索与结构化报告生成</span>
								</div>
							</div>
							<div className="research-boundary-item">
								<div className="boundary-icon persist">
									<FileText size={14} />
								</div>
								<div className="boundary-text">
									<strong>持久沉淀</strong>
									<span>写入文献库记忆与持久 Agent 会话，切换页面不丢失进度</span>
								</div>
							</div>
							<div className="research-boundary-item">
								<div className="boundary-icon human">
									<FlaskConical size={14} />
								</div>
								<div className="boundary-text">
									<strong>学者把控</strong>
									<span>核心学术结论裁决、代码复现执行、实验方案取舍与科研灵感</span>
								</div>
							</div>
						</div>

						{error && (
							<div className="error-banner">
								<AlertCircle size={16} />
								<span>{error}</span>
							</div>
						)}

						<div className="research-modal-footer">
							<div className="research-footer-runtime-hint">
								<ShieldCheck size={14} />
								<span>Paper Agent 在后台持续推进，您可随时在 Agent 页面追问讨论</span>
							</div>
							<div className="research-footer-actions">
								<button
									className="button secondary"
									type="button"
									onClick={() => setOpen(false)}
									disabled={starting}
								>
									取消
								</button>
								<button
									className="button primary research-submit-btn"
									type="button"
									disabled={!version || busy || starting}
									onClick={() => void start()}
								>
									{starting ? (
										<>
											<Loader2 size={15} className="spin-animate" />
											<span>正在创建任务…</span>
										</>
									) : (
										<>
											<Sparkles size={15} />
											<span>开始自动深入研究</span>
										</>
									)}
								</button>
							</div>
						</div>
					</div>
				</AccessibleModal>
			)}
		</div>
	);
}
