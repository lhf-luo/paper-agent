import {
	ArrowRight,
	BookOpen,
	Bot,
	ChevronLeft,
	ChevronRight,
	ClipboardPaste,
	Copy,
	Files,
	FileText,
	Focus,
	Folder,
	Hand,
	Link2,
	ListTree,
	Maximize,
	Maximize2,
	Minimize,
	MoreHorizontal,
	Pencil,
	Plus,
	Redo2,
	Search,
	Trash2,
	Undo2,
	Users,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import {
	lazy,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type WheelEvent as ReactWheelEvent,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	type CanvasRichContent,
	canvasRichPlainText,
	validCanvasUrl,
} from "../../src/canvas/domain/canvas-rich-content";
import { getTeamLeaderNames, getTeamMemberNames } from "../../src/canvas/domain/canvas-team";
import { api } from "./api";
import { connectedCanvasAgentNodes } from "./canvas-agent-nodes";
import { CanvasNotePreview } from "./canvas-note-preview";
import { type CanvasPaperDetails, CanvasPaperPreview } from "./canvas-paper-preview";
import { CanvasTextView, canvasTextDocument } from "./canvas-rich-text";
import { CanvasTextEditor } from "./canvas-text-editor";
import { buildCollectionTree, type CollectionTreeNode } from "./collection-tree";
import { readerVersionState } from "./reader-state";
import { useRouterContext } from "./router";
import type {
	AgentSessionSummary,
	PaperCollection,
	PaperRecord,
	PaperVersionView,
	ReaderState,
	ResearchNote,
	ResearchNoteFolder,
	ResearchNoteSummary,
} from "./types";
import { useElementWidth } from "./use-element-width";
import "./canvas-page.css";

const AgentPage = lazy(() => import("./agent-page").then((module) => ({ default: module.AgentPage })));
type NodeKind = "paper" | "note" | "text" | "author" | "team" | "agent";
type LinkSide = "left" | "right";
type ResizeEdge = "left" | "right" | "top" | "bottom" | "corner";
interface LinkOrigin {
	id: string;
	side: LinkSide;
}
interface CanvasNode {
	id: string;
	kind: NodeKind;
	x: number;
	y: number;
	width: number;
	height: number;
	title: string;
	alias?: string;
	content?: string;
	richContent?: CanvasRichContent;
	authorDetails?: { researchArea: string; organization: string; profileUrl?: string };
	teamDetails?: {
		institution: string;
		leaderName: string;
		researchAreas: string;
		homepageUrl?: string;
		members?: string[];
	};
	entityId?: string;
}
interface CanvasEdge {
	id: string;
	from: string;
	to: string;
	fromSide?: LinkSide;
	toSide?: LinkSide;
	label: string;
	evidence?: string;
}
interface Viewport {
	x: number;
	y: number;
	scale: number;
}
interface CanvasContextMenu {
	x: number;
	y: number;
	worldX: number;
	worldY: number;
	view: "root" | "nodes" | "node" | "edge";
	nodeId?: string;
	edgeId?: string;
	linkFrom?: LinkOrigin;
}
interface Board {
	id: string;
	title: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	viewport: Viewport;
}
interface BoardSummary {
	id: string;
	title: string;
	revision: number;
	updatedAt: string;
	nodeCount: number;
}
type CanvasActionDialog =
	| { kind: "prompt"; title: string; value: string }
	| { kind: "confirm"; title: string; message: string; danger: boolean };
type BoardDocument = Pick<Board, "title" | "nodes" | "edges" | "viewport">;

const nodeNames: Record<NodeKind, string> = {
	paper: "论文",
	note: "笔记",
	text: "文本",
	author: "作者",
	team: "研究团队",
	agent: "Agent 对话",
};
const defaultNodeCaptions: Record<NodeKind, string> = { ...nodeNames, team: "团队" };
const nodeManagerKinds: NodeKind[] = ["text", "paper", "note", "author", "team", "agent"];
const nodeIcons = { paper: BookOpen, note: FileText, text: FileText, author: Users, team: Users, agent: Bot };
const teamRelationLabel = (from?: CanvasNode, to?: CanvasNode) => {
	if (!from || !to) return "";
	if ((from.kind === "team" && to.kind === "author") || (from.kind === "author" && to.kind === "team")) return "成员";
	if ((from.kind === "team" && to.kind === "paper") || (from.kind === "paper" && to.kind === "team"))
		return "研究成果";
	return "";
};
const documentOf = (board: Board): BoardDocument => ({
	title: board.title,
	nodes: board.nodes,
	edges: board.edges,
	viewport: board.viewport,
});
function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
	const result = new Map(current.map((item) => [item.id, item]));
	for (const item of incoming) result.set(item.id, item);
	return [...result.values()];
}
function visiblePickerCollections(tree: CollectionTreeNode[], expanded: Set<string>) {
	const rows: Array<{ collection: PaperCollection; depth: number; hasChildren: boolean }> = [];
	const visit = (nodes: CollectionTreeNode[], depth: number) => {
		for (const node of nodes) {
			rows.push({ collection: node.collection, depth, hasChildren: node.children.length > 0 });
			if (expanded.has(node.collection.id)) visit(node.children, depth + 1);
		}
	};
	visit(tree, 0);
	return rows;
}
function visiblePickerNoteFolders(folders: ResearchNoteFolder[], expanded: Set<string>) {
	const children = new Map<string, ResearchNoteFolder[]>();
	for (const folder of folders) {
		const parent = folder.parentId ?? "root";
		children.set(parent, [...(children.get(parent) ?? []), folder]);
	}
	for (const siblings of children.values()) siblings.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
	const rows: Array<{ folder: ResearchNoteFolder; depth: number; hasChildren: boolean }> = [];
	const visit = (parent: string, depth: number) => {
		for (const folder of children.get(parent) ?? []) {
			const hasChildren = children.has(folder.id);
			rows.push({ folder, depth, hasChildren });
			if (hasChildren && expanded.has(folder.id)) visit(folder.id, depth + 1);
		}
	};
	visit("root", 0);
	return rows;
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function textEditorPosition(card: HTMLElement) {
	const rect = card.getBoundingClientRect();
	const width = Math.max(rect.width, 260);
	const height = Math.max(rect.height, 220);
	return {
		left: clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8)),
		top: clamp(rect.top, 8, Math.max(8, window.innerHeight - height - 8)),
		width,
		height,
	};
}

function endpoint(node: CanvasNode, toward: CanvasNode, height: number, side?: LinkSide) {
	const cx = node.x + node.width / 2;
	const cy = node.y + height / 2;
	const tx = toward.x + toward.width / 2;
	return {
		x: cx + (side === "right" || (!side && tx >= cx) ? node.width / 2 : -node.width / 2),
		y: cy,
	};
}

function Connection({
	edge,
	from,
	to,
	fromHeight,
	toHeight,
	selected,
	onSelect,
	onEdit,
}: {
	edge: CanvasEdge;
	from: CanvasNode;
	to: CanvasNode;
	fromHeight: number;
	toHeight: number;
	selected: boolean;
	onSelect: () => void;
	onEdit: () => void;
}) {
	const start = endpoint(from, to, fromHeight, edge.fromSide);
	const end = endpoint(to, from, toHeight, edge.toSide);
	const bend = Math.max(55, Math.abs(end.x - start.x) * 0.45);
	const path = `M ${start.x} ${start.y} C ${start.x + (end.x >= start.x ? bend : -bend)} ${start.y}, ${end.x + (end.x >= start.x ? -bend : bend)} ${end.y}, ${end.x} ${end.y}`;
	return (
		// biome-ignore lint/a11y/useSemanticElements: An SVG connection cannot contain a native HTML button.
		<g
			className={`research-canvas-edge${selected ? " selected" : ""}`}
			data-edge-id={edge.id}
			role="button"
			tabIndex={0}
			aria-label={`编辑${edge.label || "连线"}`}
			onPointerDown={(event) => {
				event.stopPropagation();
				onSelect();
			}}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				event.stopPropagation();
				onEdit();
			}}
		>
			<path d={path} className="research-canvas-edge-hit" />
			<path d={path} className="research-canvas-edge-line" />
			<circle cx={end.x} cy={end.y} r={4} className="research-canvas-edge-end" />
			{edge.label && edge.label !== "关联" && (
				<g transform={`translate(${(start.x + end.x) / 2} ${(start.y + end.y) / 2})`}>
					<rect
						x={-Math.min(90, edge.label.length * 7 + 12) / 2}
						y={-12}
						width={Math.min(90, edge.label.length * 7 + 12)}
						height={24}
						rx={8}
						className="research-canvas-edge-label-bg"
					/>
					<text textAnchor="middle" dominantBaseline="middle" className="research-canvas-edge-label">
						{edge.label.length > 12 ? `${edge.label.slice(0, 11)}…` : edge.label}
					</text>
				</g>
			)}
		</g>
	);
}

export default function CanvasPage({
	defaultNamespace,
	onOpenReader,
}: {
	defaultNamespace: string;
	onOpenReader: (reader: ReaderState) => void;
}) {
	const router = useRouterContext();
	const namespace = router.params.namespace || defaultNamespace;
	const [boards, setBoards] = useState<BoardSummary[]>([]);
	const [board, setBoard] = useState<Board>();
	const boardRef = useRef<Board | undefined>(undefined);
	const [selectedNode, setSelectedNode] = useState<string>();
	const [selectedEdge, setSelectedEdge] = useState<string>();
	const [editingEdge, setEditingEdge] = useState<{ id: string; label: string; evidence: string }>();
	const [editingAuthor, setEditingAuthor] = useState<{
		id: string;
		title: string;
		researchArea: string;
		organization: string;
		profileUrl: string;
	}>();
	const [editingTeam, setEditingTeam] = useState<{
		id: string;
		title: string;
		institution: string;
		leaderName: string;
		researchAreas: string;
		homepageUrl: string;
		content: string;
		members: string[];
	}>();
	const [teamMemberDraft, setTeamMemberDraft] = useState("");
	const [editingText, setEditingText] = useState<{
		id: string;
		portal: HTMLElement;
		position: { left: number; top: number; width: number; height: number };
	}>();
	const [connectingFrom, setConnectingFrom] = useState<string>();
	const [connectingSide, setConnectingSide] = useState<LinkSide>();
	const [linkPreview, setLinkPreview] = useState<{
		from: string;
		side: LinkSide;
		x: number;
		y: number;
		targetId?: string;
		targetSide?: LinkSide;
	}>();
	const [picker, setPicker] = useState<"paper" | "note">();
	const [contextMenu, setContextMenu] = useState<CanvasContextMenu>();
	const [nodeClipboard, setNodeClipboard] = useState<{ namespace: string; boardId?: string; node: CanvasNode }>();
	const pendingNodePosition = useRef<{ x: number; y: number } | undefined>(undefined);
	const pendingLinkFrom = useRef<LinkOrigin | undefined>(undefined);
	const [pickerQuery, setPickerQuery] = useState("");
	const [pickerCollection, setPickerCollection] = useState("all");
	const [pickerCollections, setPickerCollections] = useState<PaperCollection[]>([]);
	const [pickerExpanded, setPickerExpanded] = useState<Set<string>>(new Set());
	const [pickerCollectionsError, setPickerCollectionsError] = useState("");
	const [pickerFolder, setPickerFolder] = useState("all");
	const [pickerFolders, setPickerFolders] = useState<ResearchNoteFolder[]>([]);
	const [pickerFolderExpanded, setPickerFolderExpanded] = useState<Set<string>>(new Set());
	const [pickerFoldersError, setPickerFoldersError] = useState("");
	const [pickerNoteResults, setPickerNoteResults] = useState<{
		namespace: string;
		notes: ResearchNoteSummary[];
		error?: string;
	}>();
	const [pickerPaperResults, setPickerPaperResults] = useState<{
		key: string;
		papers: PaperRecord[];
		total: number;
		error?: string;
	}>();
	const [papers, setPapers] = useState<PaperRecord[]>([]);
	const [paperDetails, setPaperDetails] = useState<Record<string, CanvasPaperDetails>>({});
	const [paperDetailErrors, setPaperDetailErrors] = useState<Record<string, string>>({});
	const paperDetailRequests = useRef(new Set<string>());
	const [openedPaper, setOpenedPaper] = useState<{
		nodeId: string;
		paperId: string;
		left: number;
		top: number;
		width: number;
		maxHeight: number;
	}>();
	const [notes, setNotes] = useState<ResearchNoteSummary[]>([]);
	const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
	const [openedAgentId, setOpenedAgentId] = useState<string>();
	const [agentPickerOpen, setAgentPickerOpen] = useState(false);
	const [openedNote, setOpenedNote] = useState<{
		nodeId: string;
		noteId: string;
		left: number;
		top: number;
		width: number;
		maxHeight: number;
	}>();
	const openedNoteDirty = useRef(false);
	const suppressNodeClick = useRef<string | undefined>(undefined);
	const [newTitle, setNewTitle] = useState("");
	const [boardMenu, setBoardMenu] = useState<{ id: string; left: number; top: number }>();
	const [boardDialog, setBoardDialog] = useState<{
		kind: "rename" | "delete";
		item: BoardSummary;
		title: string;
	}>();
	const [actionDialog, setActionDialog] = useState<CanvasActionDialog>();
	const actionResolver = useRef<((result: string | boolean | null) => void) | null>(null);
	const actionInputRef = useRef<HTMLInputElement>(null);
	const actionCancelRef = useRef<HTMLButtonElement>(null);
	const [error, setError] = useState("");
	const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "conflict">("saved");
	const [busy, setBusy] = useState(false);
	const [panelOpen, setPanelOpen] = useState(true);
	const [listOpen, setListOpen] = useState(true);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [fullscreenAddOpen, setFullscreenAddOpen] = useState(false);
	const [fullscreenNodesOpen, setFullscreenNodesOpen] = useState(false);
	const [fullscreenNodeFilter, setFullscreenNodeFilter] = useState<NodeKind | "all">("all");
	const [fullscreenNodeQuery, setFullscreenNodeQuery] = useState("");
	const [fullscreenNodeMenuId, setFullscreenNodeMenuId] = useState<string>();
	const { ref: layoutRef, width: layoutWidth } = useElementWidth<HTMLDivElement>();
	const layoutBand = useRef<"wide" | "medium" | "narrow" | undefined>(undefined);
	const [, setHistoryTick] = useState(0);
	const canvasRef = useRef<HTMLDivElement>(null);
	const authorNameInputRef = useRef<HTMLInputElement>(null);
	const teamNameInputRef = useRef<HTMLInputElement>(null);
	const boardRenameInputRef = useRef<HTMLInputElement>(null);
	const boardDialogCancelRef = useRef<HTMLButtonElement>(null);
	const edgeLabelInputRef = useRef<HTMLInputElement>(null);
	const boardMenuRef = useRef<HTMLDivElement>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<
		| { kind: "pan" | "node"; id?: string; x: number; y: number; initialX: number; initialY: number; moved: boolean }
		| undefined
	>(undefined);
	const linkDragRef = useRef<{ from: string; side: LinkSide; x: number; y: number; moved: boolean } | undefined>(
		undefined,
	);
	const resizeRef = useRef<
		| {
				id: string;
				edge: ResizeEdge;
				clientX: number;
				clientY: number;
				x: number;
				y: number;
				width: number;
				height: number;
				moved: boolean;
		  }
		| undefined
	>(undefined);
	const requestAction = useCallback((dialog: CanvasActionDialog) => {
		actionResolver.current?.(null);
		return new Promise<string | boolean | null>((resolve) => {
			actionResolver.current = resolve;
			setActionDialog(dialog);
		});
	}, []);
	const finishAction = useCallback((result: string | boolean | null) => {
		const resolve = actionResolver.current;
		actionResolver.current = null;
		setActionDialog(undefined);
		resolve?.(result);
	}, []);
	const confirmCanvasAction = useCallback(
		async (message: string, danger = false) =>
			(await requestAction({ kind: "confirm", title: "确认操作", message, danger })) === true,
		[requestAction],
	);
	const promptCanvasAction = useCallback(
		async (title: string, value: string) => {
			const result = await requestAction({ kind: "prompt", title, value });
			return typeof result === "string" ? result : null;
		},
		[requestAction],
	);
	const suppressHandleClickUntil = useRef(0);
	const history = useRef<BoardDocument[]>([]);
	const future = useRef<BoardDocument[]>([]);
	const changeVersion = useRef(0);
	const savedVersion = useRef(0);
	const revision = useRef(0);
	const saving = useRef<Promise<boolean> | null>(null);
	const saveNowRef = useRef<() => Promise<boolean>>(async () => true);
	const activeId = router.params.canvas || boards[0]?.id;
	const refreshAgentSessions = useCallback(async () => {
		if (!activeId) return [];
		const result = await api<{ sessions: AgentSessionSummary[] }>(
			`/api/agent/sessions?scope=canvas&namespace=${encodeURIComponent(namespace)}&canvasId=${encodeURIComponent(activeId)}`,
		);
		setAgentSessions(result.sessions);
		return result.sessions;
	}, [activeId, namespace]);
	useEffect(() => {
		setAgentSessions([]);
		setOpenedAgentId(undefined);
		setAgentPickerOpen(false);
		if (!activeId) return;
		let cancelled = false;
		const refresh = async () => {
			try {
				const result = await api<{ sessions: AgentSessionSummary[] }>(
					`/api/agent/sessions?scope=canvas&namespace=${encodeURIComponent(namespace)}&canvasId=${encodeURIComponent(activeId)}`,
				);
				if (!cancelled) setAgentSessions(result.sessions);
			} catch {
				// The chat panel reports service errors when opened.
			}
		};
		void refresh();
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 5_000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [activeId, namespace]);
	const editingAuthorId = editingAuthor?.id;
	const editingTeamId = editingTeam?.id;
	useEffect(() => {
		if (selectedNode !== undefined) setTeamMemberDraft("");
	}, [selectedNode]);
	useEffect(() => {
		if (boardDialog?.kind === "rename") boardRenameInputRef.current?.focus();
		else if (boardDialog?.kind === "delete") boardDialogCancelRef.current?.focus();
	}, [boardDialog?.kind]);
	useEffect(() => {
		if (actionDialog?.kind === "prompt") actionInputRef.current?.select();
		else if (actionDialog?.kind === "confirm") actionCancelRef.current?.focus();
	}, [actionDialog?.kind]);
	useEffect(
		() => () => {
			actionResolver.current?.(null);
			actionResolver.current = null;
		},
		[],
	);
	useEffect(() => {
		if (editingEdge?.id) edgeLabelInputRef.current?.focus();
	}, [editingEdge?.id]);
	useEffect(() => {
		if (!boardMenu) return;
		boardMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
		const closeOnPointerDown = (event: PointerEvent) => {
			if (!(event.target as HTMLElement).closest(".research-canvas-board-menu, .research-canvas-board-settings"))
				setBoardMenu(undefined);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setBoardMenu(undefined);
		};
		window.addEventListener("pointerdown", closeOnPointerDown);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			window.removeEventListener("pointerdown", closeOnPointerDown);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [boardMenu]);
	useEffect(() => {
		if (editingAuthorId) authorNameInputRef.current?.focus();
	}, [editingAuthorId]);
	useEffect(() => {
		if (editingTeamId) teamNameInputRef.current?.focus();
	}, [editingTeamId]);
	useEffect(() => {
		let frame = 0;
		const updateFullscreen = () => {
			const page = layoutRef.current;
			const fullscreen = document.fullscreenElement === page;
			setIsFullscreen(fullscreen);
			if (!fullscreen) {
				setFullscreenAddOpen(false);
				setFullscreenNodesOpen(false);
				setFullscreenNodeMenuId(undefined);
			}
			window.cancelAnimationFrame(frame);
			frame = window.requestAnimationFrame(() => {
				const portal = fullscreen && page ? page : document.body;
				setEditingText((current) => {
					if (!current) return current;
					const card = canvasRef.current?.querySelector<HTMLElement>(
						`[data-node-id="${current.id}"] .research-canvas-node`,
					);
					if (!card) return { ...current, portal };
					return { ...current, portal, position: textEditorPosition(card) };
				});
			});
		};
		document.addEventListener("fullscreenchange", updateFullscreen);
		window.addEventListener("resize", updateFullscreen);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("fullscreenchange", updateFullscreen);
			window.removeEventListener("resize", updateFullscreen);
		};
	}, [layoutRef]);
	const toggleFullscreen = async () => {
		const page = layoutRef.current;
		if (!page) return;
		try {
			if (document.fullscreenElement === page) await document.exitFullscreen();
			else await page.requestFullscreen();
		} catch {
			setError("无法切换全屏，请检查浏览器是否允许全屏显示。");
		}
	};
	useEffect(() => {
		if (!layoutWidth || document.fullscreenElement?.classList.contains("research-canvas-page")) return;
		const band = layoutWidth <= 500 ? "narrow" : layoutWidth <= 800 ? "medium" : "wide";
		if (layoutBand.current === band) return;
		layoutBand.current = band;
		if (band === "narrow") {
			setListOpen(false);
			setPanelOpen(false);
		} else if (band === "medium") {
			setListOpen(true);
			setPanelOpen(false);
		} else {
			setListOpen(true);
			setPanelOpen(true);
		}
	}, [layoutWidth]);
	const refreshBoards = useCallback(async () => {
		const result = await api<{ canvases: BoardSummary[] }>(
			`/api/canvases?namespace=${encodeURIComponent(namespace)}`,
		);
		setBoards(result.canvases);
		return result.canvases;
	}, [namespace]);

	useEffect(() => {
		let cancelled = false;
		setBoard(undefined);
		setBoards([]);
		setError("");
		void refreshBoards().catch((reason) => {
			if (!cancelled) setError(String(reason));
		});
		return () => {
			cancelled = true;
		};
	}, [refreshBoards]);

	useEffect(() => {
		if (!activeId) {
			setBoard(undefined);
			boardRef.current = undefined;
			return;
		}
		let cancelled = false;
		void (async () => {
			if (boardRef.current?.id !== activeId && savedVersion.current < changeVersion.current) {
				if (!(await saveNowRef.current())) return;
			}
			if (cancelled) return;
			const { canvas, references } = await api<{
				canvas: Board;
				references: { papers: PaperRecord[]; notes: ResearchNoteSummary[] };
			}>(`/api/canvases/${encodeURIComponent(activeId)}?namespace=${encodeURIComponent(namespace)}`);
			if (cancelled) return;
			setPapers(references.papers);
			setPaperDetails({});
			setPaperDetailErrors({});
			setOpenedPaper(undefined);
			setNotes(references.notes);
			setOpenedNote(undefined);
			openedNoteDirty.current = false;
			boardRef.current = canvas;
			setBoard(canvas);
			resizeRef.current = undefined;
			revision.current = canvas.revision;
			changeVersion.current = 0;
			savedVersion.current = 0;
			history.current = [];
			future.current = [];
			setHistoryTick((value) => value + 1);
			setSelectedNode(undefined);
			setSelectedEdge(undefined);
			setEditingEdge(undefined);
			setEditingAuthor(undefined);
			setEditingTeam(undefined);
			setEditingText(undefined);
			setConnectingFrom(undefined);
			setConnectingSide(undefined);
			setLinkPreview(undefined);
			setContextMenu(undefined);
			setPicker(undefined);
			setFullscreenAddOpen(false);
			setFullscreenNodeMenuId(undefined);
			pendingNodePosition.current = undefined;
			pendingLinkFrom.current = undefined;
			setSaveState("saved");
		})().catch((reason) => {
			if (!cancelled) setError(String(reason));
		});
		return () => {
			cancelled = true;
		};
	}, [activeId, namespace]);

	const saveNow = useCallback(async (): Promise<boolean> => {
		if (saving.current) return saving.current;
		const current = boardRef.current;
		if (!current || savedVersion.current >= changeVersion.current) return true;
		if (saveState === "conflict") return false;
		if (!current.title.trim()) {
			setError("请填写画布名称后再保存。");
			return false;
		}
		const sentVersion = changeVersion.current;
		const promise = (async () => {
			setSaveState("saving");
			try {
				const result = await api<{ canvas: Board }>(`/api/canvases/${encodeURIComponent(current.id)}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ namespace, expectedRevision: revision.current, document: documentOf(current) }),
				});
				revision.current = result.canvas.revision;
				savedVersion.current = sentVersion;
				setSaveState(savedVersion.current === changeVersion.current ? "saved" : "unsaved");
				setBoards((items) =>
					items.map((item) =>
						item.id === current.id
							? {
									...item,
									title: current.title,
									revision: result.canvas.revision,
									updatedAt: result.canvas.updatedAt,
									nodeCount: current.nodes.length,
								}
							: item,
					),
				);
				return true;
			} catch (reason) {
				const message = reason instanceof Error ? reason.message : String(reason);
				setError(message);
				setSaveState(message.includes("其他页面修改") ? "conflict" : "unsaved");
				return false;
			}
		})();
		saving.current = promise;
		const okay = await promise;
		saving.current = null;
		return okay;
	}, [namespace, saveState]);
	const flush = useCallback(async (): Promise<boolean> => {
		for (let attempt = 0; attempt < 20 && savedVersion.current < changeVersion.current; attempt++) {
			if (!(await saveNow())) return false;
		}
		return savedVersion.current >= changeVersion.current;
	}, [saveNow]);

	useEffect(() => {
		if (busy || !board || savedVersion.current >= changeVersion.current || saveState === "conflict") return;
		const timer = window.setTimeout(() => {
			void saveNow();
		}, 650);
		return () => window.clearTimeout(timer);
	}, [board, busy, saveNow, saveState]);

	useEffect(() => {
		saveNowRef.current = flush;
	}, [flush]);
	useEffect(
		() => () => {
			if (boardRef.current && savedVersion.current < changeVersion.current) void saveNowRef.current();
		},
		[],
	);

	const edit = useCallback((change: (current: Board) => Board, recordHistory = true) => {
		const current = boardRef.current;
		if (!current) return;
		if (recordHistory) {
			history.current = [...history.current.slice(-49), documentOf(current)];
			future.current = [];
			setHistoryTick((value) => value + 1);
		}
		const next = change(current);
		boardRef.current = next;
		setBoard(next);
		changeVersion.current += 1;
		setSaveState("unsaved");
		setError("");
	}, []);
	const editEdge = (edge: CanvasEdge) => {
		setContextMenu(undefined);
		setSelectedEdge(edge.id);
		setSelectedNode(undefined);
		if (isFullscreen) setEditingEdge({ id: edge.id, label: edge.label, evidence: edge.evidence ?? "" });
		else setPanelOpen(true);
	};
	const deleteEdge = (id: string) => {
		if (!boardRef.current?.edges.some((edge) => edge.id === id)) return;
		edit((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== id) }));
		setSelectedEdge(undefined);
		setContextMenu(undefined);
		setEditingEdge(undefined);
	};
	const saveEdgeEditing = () => {
		if (!editingEdge) return;
		const original = boardRef.current?.edges.find((edge) => edge.id === editingEdge.id);
		if (original && (original.label !== editingEdge.label || (original.evidence ?? "") !== editingEdge.evidence)) {
			edit((current) => ({
				...current,
				edges: current.edges.map((edge) =>
					edge.id === editingEdge.id
						? { ...edge, label: editingEdge.label, evidence: editingEdge.evidence }
						: edge,
				),
			}));
		}
		setEditingEdge(undefined);
	};

	const undo = useCallback(() => {
		const current = boardRef.current;
		const previous = history.current.pop();
		if (!current || !previous) return;
		future.current.push(documentOf(current));
		const next = { ...current, ...previous };
		boardRef.current = next;
		setBoard(next);
		changeVersion.current += 1;
		setHistoryTick((value) => value + 1);
		setSaveState("unsaved");
	}, []);
	const redo = useCallback(() => {
		const current = boardRef.current;
		const nextDocument = future.current.pop();
		if (!current || !nextDocument) return;
		history.current.push(documentOf(current));
		const next = { ...current, ...nextDocument };
		boardRef.current = next;
		setBoard(next);
		changeVersion.current += 1;
		setHistoryTick((value) => value + 1);
		setSaveState("unsaved");
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (busy || boardDialog || actionDialog || boardMenu) return;
			if (editingEdge) {
				if (event.key === "Escape") setEditingEdge(undefined);
				return;
			}
			if (event.key === "Escape") {
				if (fullscreenNodeMenuId || fullscreenAddOpen || fullscreenNodesOpen) {
					setFullscreenNodeMenuId(undefined);
					setFullscreenAddOpen(false);
					if (!fullscreenNodeMenuId && !fullscreenAddOpen) setFullscreenNodesOpen(false);
					return;
				}
				setContextMenu(undefined);
				setPicker(undefined);
				pendingNodePosition.current = undefined;
				pendingLinkFrom.current = undefined;
				setConnectingFrom(undefined);
				setConnectingSide(undefined);
				setLinkPreview(undefined);
				linkDragRef.current = undefined;
				resizeRef.current = undefined;
				setSelectedNode(undefined);
				setSelectedEdge(undefined);
				setEditingAuthor(undefined);
				setEditingTeam(undefined);
				return;
			}
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) redo();
				else undo();
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
				event.preventDefault();
				redo();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		undo,
		redo,
		busy,
		boardDialog,
		actionDialog,
		boardMenu,
		editingEdge,
		fullscreenAddOpen,
		fullscreenNodesOpen,
		fullscreenNodeMenuId,
	]);
	useEffect(() => {
		if (!contextMenu) return;
		contextMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
		const closeOnOutsideClick = (event: PointerEvent) => {
			if (!(event.target instanceof Element) || !contextMenuRef.current?.contains(event.target)) {
				setContextMenu(undefined);
			}
		};
		window.addEventListener("pointerdown", closeOnOutsideClick, true);
		return () => window.removeEventListener("pointerdown", closeOnOutsideClick, true);
	}, [contextMenu]);

	const paperById = useMemo(() => new Map(papers.map((paper) => [paper.id, paper])), [papers]);
	const agentById = useMemo(() => new Map(agentSessions.map((session) => [session.id, session])), [agentSessions]);
	const paperDetailKey = (paperId: string) => `${namespace}/${paperId}`;
	const loadPaperDetails = (paperId: string) => {
		const key = paperDetailKey(paperId);
		const sourceBoardId = boardRef.current?.id;
		if (paperDetails[key] || paperDetailRequests.current.has(key)) return;
		paperDetailRequests.current.add(key);
		setPaperDetailErrors((current) => {
			if (!current[key]) return current;
			const next = { ...current };
			delete next[key];
			return next;
		});
		void api<CanvasPaperDetails>(
			`/api/papers/${encodeURIComponent(paperId)}?namespace=${encodeURIComponent(namespace)}`,
		)
			.then((details) => {
				if (boardRef.current?.id === sourceBoardId) setPaperDetails((current) => ({ ...current, [key]: details }));
			})
			.catch((reason) => {
				if (boardRef.current?.id === sourceBoardId)
					setPaperDetailErrors((current) => ({ ...current, [key]: String(reason) }));
			})
			.finally(() => paperDetailRequests.current.delete(key));
	};
	const closePaperPreview = () => {
		setOpenedPaper(undefined);
	};
	useEffect(() => {
		if (!openedPaper) return;
		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpenedPaper(undefined);
			}
		};
		window.addEventListener("keydown", onEscape);
		return () => window.removeEventListener("keydown", onEscape);
	}, [openedPaper]);
	const openPaperPreview = (node: CanvasNode, element: HTMLElement) => {
		if (
			node.kind !== "paper" ||
			!node.entityId ||
			!paperById.has(node.entityId) ||
			contextMenu ||
			connectingFrom ||
			linkPreview ||
			dragRef.current ||
			resizeRef.current
		)
			return;
		const stage = canvasRef.current?.getBoundingClientRect();
		if (!stage) return;
		const card = element.getBoundingClientRect();
		const width = Math.min(620, Math.max(0, stage.width - 24));
		const maxHeight = Math.min(640, Math.max(0, stage.height - 24));
		if (width < 180 || maxHeight < 150) return;
		let left = card.right - stage.left + 10;
		if (left + width > stage.width - 12) left = card.left - stage.left - width - 10;
		left = clamp(left, 12, stage.width - width - 12);
		const top = clamp(card.top - stage.top, 12, stage.height - maxHeight - 12);
		setOpenedPaper((current) =>
			current?.nodeId === node.id
				? current
				: { nodeId: node.id, paperId: node.entityId!, left, top, width, maxHeight },
		);
		loadPaperDetails(node.entityId);
	};
	const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
	const openNotePreview = async (node: CanvasNode, element: HTMLElement) => {
		if (node.kind !== "note" || !node.entityId || connectingFrom || linkPreview || contextMenu) return;
		if (!noteById.has(node.entityId)) {
			setError("个人库中已找不到这篇笔记。");
			return;
		}
		if (openedNote?.nodeId === node.id) return;
		if (openedNoteDirty.current && !(await confirmCanvasAction("笔记有未保存的修改。放弃修改并打开另一篇吗？")))
			return;
		const stage = canvasRef.current?.getBoundingClientRect();
		if (!stage) return;
		const card = element.getBoundingClientRect();
		const width = Math.min(620, Math.max(0, stage.width - 24));
		const maxHeight = Math.min(640, Math.max(0, stage.height - 24));
		if (width < 180 || maxHeight < 150) return;
		let left = card.right - stage.left + 10;
		if (left + width > stage.width - 12) left = card.left - stage.left - width - 10;
		openedNoteDirty.current = false;
		closePaperPreview();
		setOpenedNote({
			nodeId: node.id,
			noteId: node.entityId,
			left: clamp(left, 12, stage.width - width - 12),
			top: clamp(card.top - stage.top, 12, stage.height - maxHeight - 12),
			width,
			maxHeight,
		});
	};
	useEffect(() => {
		if (picker !== "paper") return;
		let cancelled = false;
		setPickerCollections([]);
		setPickerCollectionsError("");
		void api<PaperCollection[]>(`/api/library/collections?namespace=${encodeURIComponent(namespace)}`)
			.then((collections) => {
				if (cancelled) return;
				setPickerCollections(collections);
				setPickerExpanded(
					new Set(
						collections
							.filter((item) => collections.some((child) => child.parentId === item.id))
							.map((item) => item.id),
					),
				);
			})
			.catch((reason) => {
				if (!cancelled) setPickerCollectionsError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [picker, namespace]);
	useEffect(() => {
		if (picker !== "note") return;
		let cancelled = false;
		setPickerFolders([]);
		setPickerFoldersError("");
		setPickerNoteResults(undefined);
		void api<{ folders: ResearchNoteFolder[] }>(`/api/research/folders?namespace=${encodeURIComponent(namespace)}`)
			.then(({ folders }) => {
				if (cancelled) return;
				setPickerFolders(folders);
				setPickerFolderExpanded(
					new Set(
						folders.filter((item) => folders.some((child) => child.parentId === item.id)).map((item) => item.id),
					),
				);
			})
			.catch((reason) => {
				if (!cancelled) setPickerFoldersError(reason instanceof Error ? reason.message : String(reason));
			});
		void api<{ notes: ResearchNoteSummary[] }>(`/api/research/notes?namespace=${encodeURIComponent(namespace)}`)
			.then(({ notes: records }) => {
				if (cancelled) return;
				setPickerNoteResults({ namespace, notes: records });
				setNotes((current) => mergeById(current, records));
			})
			.catch((reason) => {
				if (!cancelled)
					setPickerNoteResults({
						namespace,
						notes: [],
						error: reason instanceof Error ? reason.message : String(reason),
					});
			});
		return () => {
			cancelled = true;
		};
	}, [picker, namespace]);
	const pickerPaperKey = `${namespace}\u0000${pickerCollection}\u0000${pickerQuery}`;
	useEffect(() => {
		if (picker !== "paper") return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			const params = new URLSearchParams({ namespace, limit: "300", q: pickerQuery });
			if (pickerCollection !== "all") params.set("collection", pickerCollection);
			void api<{ hits: Array<{ record: PaperRecord }>; total: number }>(`/api/library?${params.toString()}`)
				.then((result) => {
					if (!cancelled) {
						const records = result.hits.map((hit) => hit.record);
						setPickerPaperResults({ key: pickerPaperKey, papers: records, total: result.total });
						setPapers((current) => mergeById(current, records));
					}
				})
				.catch((reason) => {
					if (!cancelled)
						setPickerPaperResults({ key: pickerPaperKey, papers: [], total: 0, error: String(reason) });
				});
		}, 180);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [picker, pickerQuery, pickerCollection, pickerPaperKey, namespace]);

	const selected = board?.nodes.find((node) => node.id === selectedNode);
	const edgeSelected = board?.edges.find((edge) => edge.id === selectedEdge);
	const editingEdgeRecord = board?.edges.find((edge) => edge.id === editingEdge?.id);
	const nodeMap = useMemo(() => new Map(board?.nodes.map((node) => [node.id, node]) ?? []), [board?.nodes]);
	const connectedAgentNodes = useMemo(
		() =>
			board && openedAgentId
				? connectedCanvasAgentNodes({
						nodes: board.nodes,
						edges: board.edges,
						sessionId: openedAgentId,
						namespace,
						papers: paperById,
						notes: noteById,
					})
				: [],
		[board, openedAgentId, namespace, paperById, noteById],
	);
	const teamLeaderNames = (teamId: string) => getTeamLeaderNames(board?.nodes ?? [], board?.edges ?? [], teamId);
	const teamMemberNames = (node: CanvasNode) =>
		getTeamMemberNames(
			board?.nodes ?? [],
			board?.edges ?? [],
			node.id,
			node.teamDetails?.members ?? [],
			node.teamDetails?.leaderName ?? "",
		);
	const contextNode = contextMenu?.nodeId ? nodeMap.get(contextMenu.nodeId) : undefined;
	const contextEdge = contextMenu?.edgeId ? board?.edges.find((edge) => edge.id === contextMenu.edgeId) : undefined;
	const nodeCaption = (node: CanvasNode) => node.alias?.trim() || defaultNodeCaptions[node.kind];
	const nodeTitle = (node: CanvasNode) =>
		node.kind === "paper"
			? (paperById.get(node.entityId ?? "")?.title ?? node.title)
			: node.kind === "note"
				? (noteById.get(node.entityId ?? "")?.title ?? node.title)
				: node.kind === "agent"
					? (agentById.get(node.entityId ?? "")?.title ?? node.title)
					: node.title;
	const startAuthorEditing = (node: CanvasNode) => {
		if (node.kind !== "author") return;
		setSelectedNode(node.id);
		setSelectedEdge(undefined);
		setEditingAuthor({
			id: node.id,
			title: node.title === "作者姓名" ? "" : node.title,
			researchArea: node.authorDetails?.researchArea ?? "",
			organization: node.authorDetails?.organization ?? "",
			profileUrl: node.authorDetails?.profileUrl ?? "",
		});
	};
	const saveAuthorEditing = () => {
		if (!editingAuthor) return;
		const { id, title, researchArea, organization, profileUrl } = editingAuthor;
		if (profileUrl.trim() && !validCanvasUrl(profileUrl.trim())) {
			setError("作者姓名链接必须是完整的 http 或 https 地址。");
			return;
		}
		edit((current) => ({
			...current,
			nodes: current.nodes.map((node) =>
				node.id === id
					? {
							...node,
							title: title.trim(),
							authorDetails: {
								researchArea: researchArea.trim(),
								organization: organization.trim(),
								...(profileUrl.trim() ? { profileUrl: profileUrl.trim() } : {}),
							},
						}
					: node,
			),
		}));
		setEditingAuthor(undefined);
	};
	const startTeamEditing = (node: CanvasNode) => {
		if (node.kind !== "team") return;
		setSelectedNode(node.id);
		setSelectedEdge(undefined);
		setEditingTeam({
			id: node.id,
			title: node.title,
			institution: node.teamDetails?.institution ?? "",
			leaderName: node.teamDetails?.leaderName ?? "",
			researchAreas: node.teamDetails?.researchAreas ?? "",
			homepageUrl: node.teamDetails?.homepageUrl ?? "",
			content: node.content ?? "",
			members: [...(node.teamDetails?.members ?? [])],
		});
	};
	const saveTeamEditing = () => {
		if (!editingTeam) return;
		const { id, title, institution, leaderName, researchAreas, homepageUrl, content } = editingTeam;
		const members = editingTeam.members.map((name) => name.trim()).filter(Boolean);
		if (new Set(members.map((name) => name.toLocaleLowerCase())).size !== members.length) {
			setError("团队成员姓名不能重复。");
			return;
		}
		const url = homepageUrl.trim();
		if (url && !validCanvasUrl(url)) {
			setError("团队主页必须是完整的 http 或 https 地址。");
			return;
		}
		edit((current) => ({
			...current,
			nodes: current.nodes.map((node) =>
				node.id === id
					? {
							...node,
							title: title.trim(),
							content: content.trim(),
							teamDetails: {
								institution: institution.trim(),
								leaderName: leaderName.trim(),
								researchAreas: researchAreas.trim(),
								members,
								...(url ? { homepageUrl: url } : {}),
							},
						}
					: node,
			),
		}));
		setEditingTeam(undefined);
	};
	const updateTeamDetails = (id: string, patch: Partial<NonNullable<CanvasNode["teamDetails"]>>) => {
		edit((current) => ({
			...current,
			nodes: current.nodes.map((node) =>
				node.id === id
					? {
							...node,
							teamDetails: {
								institution: node.teamDetails?.institution ?? "",
								leaderName: node.teamDetails?.leaderName ?? "",
								researchAreas: node.teamDetails?.researchAreas ?? "",
								members: node.teamDetails?.members ?? [],
								...(node.teamDetails?.homepageUrl ? { homepageUrl: node.teamDetails.homepageUrl } : {}),
								...patch,
							},
						}
					: node,
			),
		}));
	};
	const addTeamMember = (node: CanvasNode) => {
		const name = teamMemberDraft.trim();
		if (!name) return;
		const members = node.teamDetails?.members ?? [];
		if (members.some((member) => member.toLocaleLowerCase() === name.toLocaleLowerCase())) {
			setError("这位成员已在团队名单中。");
			return;
		}
		if (members.length >= 100) {
			setError("每个团队最多添加 100 位成员。");
			return;
		}
		updateTeamDetails(node.id, { members: [...members, name] });
		setTeamMemberDraft("");
	};
	const startTextEditing = (node: CanvasNode, element?: HTMLElement) => {
		if (node.kind !== "text" || !layoutRef.current) return;
		const card =
			element ?? canvasRef.current?.querySelector<HTMLElement>(`[data-node-id="${node.id}"] .research-canvas-node`);
		if (!card) return;
		const portal = document.fullscreenElement === layoutRef.current ? layoutRef.current : document.body;
		setSelectedNode(node.id);
		setSelectedEdge(undefined);
		setEditingText({
			id: node.id,
			portal,
			position: textEditorPosition(card),
		});
	};
	const saveTextEditing = (id: string, richContent: CanvasRichContent) => {
		const plain = canvasRichPlainText(richContent);
		const lines = plain.split("\n");
		const title =
			lines
				.find((line) => line.trim())
				?.trim()
				.slice(0, 300) ?? "";
		edit((current) => ({
			...current,
			nodes: current.nodes.map((node) =>
				node.id === id
					? {
							...node,
							title,
							content: lines.slice(1).join("\n").slice(0, 20_000),
							richContent,
						}
					: node,
			),
		}));
		setEditingText(undefined);
	};

	const addNode = (
		kind: NodeKind,
		entity?: { id: string; title: string },
		position?: { x: number; y: number },
		linkFrom?: LinkOrigin,
	) => {
		const current = boardRef.current;
		const rect = canvasRef.current?.getBoundingClientRect();
		if (!current || !rect) return;
		const width = kind === "text" ? 280 : 260;
		const height = kind === "text" ? 170 : 145;
		const at = position ?? (entity ? pendingNodePosition.current : undefined);
		const origin = linkFrom ?? (entity ? pendingLinkFrom.current : undefined);
		const node: CanvasNode = {
			id: crypto.randomUUID(),
			kind,
			x: at
				? at.x - width / 2
				: (rect.width / 2 - current.viewport.x) / current.viewport.scale -
					width / 2 +
					(current.nodes.length % 5) * 22,
			y: at
				? at.y - height / 2
				: (rect.height / 2 - current.viewport.y) / current.viewport.scale -
					height / 2 +
					(current.nodes.length % 5) * 22,
			width,
			height,
			title:
				entity?.title.slice(0, 300) ??
				({ text: "新想法", author: "", team: "研究团队", agent: "Agent 对话" } as Record<string, string>)[kind] ??
				"",
			...(kind === "author" ? { authorDetails: { researchArea: "", organization: "" } } : {}),
			...(kind === "team"
				? { teamDetails: { institution: "", leaderName: "", researchAreas: "", members: [] } }
				: {}),
			...(entity ? { entityId: entity.id } : {}),
		};
		const edge: CanvasEdge | undefined =
			origin && current.nodes.some((item) => item.id === origin.id)
				? {
						id: crypto.randomUUID(),
						from: origin.id,
						to: node.id,
						fromSide: origin.side,
						label: teamRelationLabel(
							current.nodes.find((item) => item.id === origin.id),
							node,
						),
					}
				: undefined;
		edit((value) => ({
			...value,
			nodes: [...value.nodes, node],
			edges: edge ? [...value.edges, edge] : value.edges,
		}));
		setSelectedNode(edge ? undefined : node.id);
		setSelectedEdge(edge?.id);
		setPicker(undefined);
		setContextMenu(undefined);
		pendingNodePosition.current = undefined;
		pendingLinkFrom.current = undefined;
		setConnectingFrom(undefined);
		setConnectingSide(undefined);
		setLinkPreview(undefined);
	};
	const createAgentNode = async (position?: { x: number; y: number }, linkFrom?: LinkOrigin) => {
		const canvasId = boardRef.current?.id;
		if (!canvasId) return;
		try {
			const session = await api<AgentSessionSummary>("/api/agent/sessions", {
				method: "POST",
				body: JSON.stringify({
					mode: "persistent",
					title: "Agent 对话",
					context: { kind: "canvas", namespace, canvasId },
				}),
			});
			setAgentSessions((current) => [session, ...current]);
			if (boardRef.current?.id !== canvasId) return;
			addNode("agent", session, position, linkFrom);
			setOpenedAgentId(session.id);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const attachAgentSession = (session: AgentSessionSummary) => {
		if (boardRef.current?.nodes.some((node) => node.kind === "agent" && node.entityId === session.id)) {
			setOpenedAgentId(session.id);
			setAgentPickerOpen(false);
			return;
		}
		addNode("agent", session);
		setOpenedAgentId(session.id);
		setAgentPickerOpen(false);
	};
	const permanentlyDeleteAgentSession = async (session: AgentSessionSummary) => {
		const current = boardRef.current;
		if (
			!current ||
			!(await confirmCanvasAction(`永久删除「${session.title}」及其聊天记录和附件？此操作无法撤销。`, true))
		)
			return;
		if (!(await flush())) return;
		try {
			const result = await api<{ canvas: Board }>(
				`/api/canvases/${encodeURIComponent(current.id)}/agent-sessions/${encodeURIComponent(session.id)}`,
				{ method: "DELETE", body: JSON.stringify({ namespace, expectedRevision: revision.current }) },
			);
			revision.current = result.canvas.revision;
			setBoard(result.canvas);
			boardRef.current = result.canvas;
			setBoards((items) =>
				items.map((item) =>
					item.id === current.id
						? { ...item, revision: result.canvas.revision, nodeCount: result.canvas.nodes.length }
						: item,
				),
			);
			setAgentSessions((items) => items.filter((item) => item.id !== session.id));
			if (openedAgentId === session.id) setOpenedAgentId(undefined);
			setSelectedNode(undefined);
			setSelectedEdge(undefined);
			history.current = [];
			future.current = [];
			changeVersion.current += 1;
			savedVersion.current = changeVersion.current;
			setSaveState("saved");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const copyNode = (node: CanvasNode) => {
		setNodeClipboard({ namespace, boardId: boardRef.current?.id, node: structuredClone(node) });
		setContextMenu(undefined);
	};
	const placeNodeCopy = async (node: CanvasNode, x: number, y: number) => {
		let entityId = node.entityId;
		if (node.kind === "agent") {
			const canvasId = boardRef.current?.id;
			if (!canvasId) return;
			try {
				const session = await api<AgentSessionSummary>("/api/agent/sessions", {
					method: "POST",
					body: JSON.stringify({
						mode: "persistent",
						title: nodeTitle(node),
						context: { kind: "canvas", namespace, canvasId },
					}),
				});
				entityId = session.id;
				setAgentSessions((current) => [session, ...current]);
				if (boardRef.current?.id !== canvasId) return;
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
				return;
			}
		}
		const copy: CanvasNode = {
			...structuredClone(node),
			id: crypto.randomUUID(),
			x,
			y,
			...(entityId ? { entityId } : {}),
		};
		edit((current) => ({ ...current, nodes: [...current.nodes, copy] }));
		setSelectedNode(copy.id);
		setSelectedEdge(undefined);
		setContextMenu(undefined);
	};
	const renameAgentSession = async (node: CanvasNode) => {
		if (node.kind === "agent" && node.entityId) {
			const title = (await promptCanvasAction("重命名 Agent 对话", nodeTitle(node)))?.trim();
			if (!title) return;
			try {
				const session = await api<AgentSessionSummary>(
					`/api/agent/sessions/${encodeURIComponent(node.entityId)}/rename`,
					{
						method: "POST",
						body: JSON.stringify({ title: title.slice(0, 120) }),
					},
				);
				setAgentSessions((current) => current.map((item) => (item.id === session.id ? session : item)));
				edit((current) => ({
					...current,
					nodes: current.nodes.map((item) => (item.id === node.id ? { ...item, title: session.title } : item)),
				}));
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			}
		}
	};
	const renameNode = async (node: CanvasNode) => {
		setContextMenu(undefined);
		const boardId = boardRef.current?.id;
		const name = await promptCanvasAction("重命名节点名称", nodeCaption(node));
		if (name === null || !name.trim()) return;
		if (boardRef.current?.id !== boardId) return;
		const nextName = name.trim().slice(0, 120);
		edit((current) => ({
			...current,
			nodes: current.nodes.map((item) =>
				item.id === node.id
					? { ...item, alias: nextName === defaultNodeCaptions[item.kind] ? undefined : nextName }
					: item,
			),
		}));
	};
	const deleteNode = async (id: string) => {
		if (
			(editingText?.id === id || editingAuthor?.id === id || editingTeam?.id === id) &&
			!(await confirmCanvasAction("正在编辑该节点。删除将放弃未保存的修改，确定删除吗？", true))
		)
			return;
		if (openedNote?.nodeId === id) {
			if (
				openedNoteDirty.current &&
				!(await confirmCanvasAction("笔记有未保存的修改。放弃修改并移除节点吗？", true))
			)
				return;
			openedNoteDirty.current = false;
			setOpenedNote(undefined);
		}
		if (boardRef.current?.nodes.find((node) => node.id === id)?.entityId === openedAgentId)
			setOpenedAgentId(undefined);
		closePaperPreview();
		edit((current) => ({
			...current,
			nodes: current.nodes.filter((node) => node.id !== id),
			edges: current.edges.filter((edge) => edge.from !== id && edge.to !== id),
		}));
		setSelectedNode(undefined);
		setSelectedEdge(undefined);
		setEditingAuthor(undefined);
		setEditingTeam(undefined);
		if (editingText?.id === id) setEditingText(undefined);
		setContextMenu(undefined);
		setFullscreenNodeMenuId(undefined);
	};
	const addNodeFromFullscreen = (kind: NodeKind) => {
		setFullscreenAddOpen(false);
		setFullscreenNodesOpen(false);
		setFullscreenNodeMenuId(undefined);
		pendingNodePosition.current = undefined;
		pendingLinkFrom.current = undefined;
		if (kind === "agent") {
			void createAgentNode();
		} else if (kind === "paper" || kind === "note") {
			setPickerQuery("");
			if (kind === "paper") setPickerCollection("all");
			else setPickerFolder("all");
			setPicker(kind);
		} else {
			addNode(kind);
		}
	};
	const jumpToNode = (node: CanvasNode, reservePanel = true) => {
		const current = boardRef.current;
		const rect = canvasRef.current?.getBoundingClientRect();
		if (!current || !rect) return;
		const coveredWidth = reservePanel ? Math.min(400, rect.width * 0.65) : 0;
		const visibleCenterX = coveredWidth + (rect.width - coveredWidth) / 2;
		edit(
			(value) => ({
				...value,
				viewport: {
					...value.viewport,
					x: visibleCenterX - (node.x + node.width / 2) * value.viewport.scale,
					y: rect.height / 2 - (node.y + node.height / 2) * value.viewport.scale,
				},
			}),
			false,
		);
		setSelectedNode(node.id);
		setSelectedEdge(undefined);
		setContextMenu(undefined);
		setFullscreenNodeMenuId(undefined);
	};
	useEffect(() => {
		if (!fullscreenAddOpen && !fullscreenNodesOpen && !fullscreenNodeMenuId) return;
		const closeMenus = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest(".research-canvas-fullscreen-ui")) return;
			setFullscreenAddOpen(false);
			setFullscreenNodesOpen(false);
			setFullscreenNodeMenuId(undefined);
		};
		window.addEventListener("pointerdown", closeMenus);
		return () => window.removeEventListener("pointerdown", closeMenus);
	}, [fullscreenAddOpen, fullscreenNodesOpen, fullscreenNodeMenuId]);
	const onCanvasContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
		closePaperPreview();
		const target = event.target as Element;
		if (target.closest("input, textarea, select, .research-canvas-context-menu")) return;
		const nodeId = target.closest<HTMLElement>(".research-canvas-node-shell")?.dataset.nodeId;
		const edgeId = target.closest<SVGGElement>(".research-canvas-edge")?.dataset.edgeId;
		if (!nodeId && !edgeId && target.closest("button")) return;
		event.preventDefault();
		const current = boardRef.current;
		if (!current) return;
		if (edgeId && !current.edges.some((edge) => edge.id === edgeId)) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		setContextMenu({
			x: clamp(x, 8, Math.max(8, rect.width - 208)),
			y: clamp(y, 8, Math.max(8, rect.height - (edgeId ? 155 : 310))),
			worldX: (x - current.viewport.x) / current.viewport.scale,
			worldY: (y - current.viewport.y) / current.viewport.scale,
			view: edgeId ? "edge" : nodeId ? "node" : "root",
			...(nodeId ? { nodeId } : {}),
			...(edgeId ? { edgeId } : {}),
		});
		if (nodeId) {
			setSelectedNode(nodeId);
			setSelectedEdge(undefined);
		} else if (edgeId) {
			setSelectedEdge(edgeId);
			setSelectedNode(undefined);
		}
	};
	const addNodeFromContextMenu = (kind: NodeKind) => {
		if (!contextMenu) return;
		const position = { x: contextMenu.worldX, y: contextMenu.worldY };
		const linkFrom = contextMenu.linkFrom;
		setContextMenu(undefined);
		if (kind === "agent") {
			void createAgentNode(position, linkFrom);
		} else if (kind === "paper" || kind === "note") {
			pendingNodePosition.current = position;
			pendingLinkFrom.current = linkFrom;
			setPickerQuery("");
			if (kind === "paper") setPickerCollection("all");
			else setPickerFolder("all");
			setPicker(kind);
		} else {
			addNode(kind, undefined, position, linkFrom);
		}
	};

	const connectNodes = (from: string, to: string, fromSide?: LinkSide, toSide?: LinkSide) => {
		if (from === to) return;
		const current = boardRef.current;
		const edge: CanvasEdge = {
			id: crypto.randomUUID(),
			from,
			to,
			label: teamRelationLabel(
				current?.nodes.find((node) => node.id === from),
				current?.nodes.find((node) => node.id === to),
			),
			fromSide,
			toSide,
		};
		edit((value) => ({ ...value, edges: [...value.edges, edge] }));
		setSelectedEdge(edge.id);
		setSelectedNode(undefined);
		setConnectingFrom(undefined);
		setConnectingSide(undefined);
		setLinkPreview(undefined);
	};
	const chooseNode = (id: string) => {
		if (connectingFrom && connectingFrom !== id) {
			connectNodes(connectingFrom, id, connectingSide);
			return;
		}
		setSelectedNode(id);
		setSelectedEdge(undefined);
	};
	const findLinkTarget = (clientX: number, clientY: number, from: string) => {
		let nearest: { id: string; side: LinkSide; x: number; y: number; score: number } | undefined;
		for (const element of canvasRef.current?.querySelectorAll<HTMLElement>(".research-canvas-node-shell") ?? []) {
			const id = element.dataset.nodeId;
			if (!id || id === from) continue;
			const rect = element.getBoundingClientRect();
			const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
			const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
			const distance = Math.hypot(dx, dy);
			if (distance > 44) continue;
			const side: LinkSide = clientX < rect.left + rect.width / 2 ? "left" : "right";
			const x = side === "left" ? rect.left : rect.right;
			const y = rect.top + rect.height / 2;
			const score = distance * 2 + Math.hypot(clientX - x, clientY - y) * 0.1;
			if (!nearest || score < nearest.score) nearest = { id, side, x, y, score };
		}
		return nearest;
	};
	const updateLinkPreview = (from: string, side: LinkSide, clientX: number, clientY: number) => {
		const current = boardRef.current;
		const rect = canvasRef.current?.getBoundingClientRect();
		if (!current || !rect) return;
		const target = findLinkTarget(clientX, clientY, from);
		const previewX = target?.x ?? clientX;
		const previewY = target?.y ?? clientY;
		setLinkPreview({
			from,
			side,
			x: (previewX - rect.left - current.viewport.x) / current.viewport.scale,
			y: (previewY - rect.top - current.viewport.y) / current.viewport.scale,
			targetId: target?.id,
			targetSide: target?.side,
		});
	};
	const onLinkHandlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, from: string, side: LinkSide) => {
		if (event.button !== 0) return;
		closePaperPreview();
		event.stopPropagation();
		linkDragRef.current = { from, side, x: event.clientX, y: event.clientY, moved: false };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onLinkHandlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const drag = linkDragRef.current;
		if (!drag) return;
		event.stopPropagation();
		if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
		drag.moved = true;
		setConnectingFrom(drag.from);
		setConnectingSide(drag.side);
		updateLinkPreview(drag.from, drag.side, event.clientX, event.clientY);
	};
	const onLinkHandlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const drag = linkDragRef.current;
		if (!drag) return;
		event.stopPropagation();
		if (drag.moved) {
			suppressHandleClickUntil.current = performance.now() + 250;
			const target = findLinkTarget(event.clientX, event.clientY, drag.from);
			const rect = canvasRef.current?.getBoundingClientRect();
			const current = boardRef.current;
			if (target) connectNodes(drag.from, target.id, drag.side, target.side);
			else if (
				rect &&
				current &&
				event.clientX >= rect.left &&
				event.clientX <= rect.right &&
				event.clientY >= rect.top &&
				event.clientY <= rect.bottom &&
				document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".research-canvas-node-shell")
					?.dataset.nodeId !== drag.from
			) {
				const x = event.clientX - rect.left;
				const y = event.clientY - rect.top;
				setContextMenu({
					x: clamp(x, 8, Math.max(8, rect.width - 208)),
					y: clamp(y, 8, Math.max(8, rect.height - 310)),
					worldX: (x - current.viewport.x) / current.viewport.scale,
					worldY: (y - current.viewport.y) / current.viewport.scale,
					view: "nodes",
					linkFrom: { id: drag.from, side: drag.side },
				});
			}
			setConnectingFrom(undefined);
			setConnectingSide(undefined);
			setLinkPreview(undefined);
		}
		linkDragRef.current = undefined;
	};
	const onLinkHandleClick = (id: string, side: LinkSide) => {
		if (performance.now() < suppressHandleClickUntil.current) return;
		if (connectingFrom === id) {
			setConnectingFrom(undefined);
			setConnectingSide(undefined);
		} else if (connectingFrom) connectNodes(connectingFrom, id, connectingSide, side);
		else {
			setConnectingFrom(id);
			setConnectingSide(side);
		}
	};

	const onNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode) => {
		if (event.button !== 0) return;
		suppressNodeClick.current = undefined;
		closePaperPreview();
		const card = event.currentTarget;
		const bounds = card.getBoundingClientRect();
		if (
			(card.scrollHeight > card.clientHeight + 1 && event.clientX >= bounds.right - 18) ||
			(card.scrollWidth > card.clientWidth + 1 && event.clientY >= bounds.bottom - 18)
		)
			return;
		event.stopPropagation();
		setSelectedNode(node.id);
		setSelectedEdge(undefined);
		if (connectingFrom) return;
		dragRef.current = {
			kind: "node",
			id: node.id,
			x: event.clientX,
			y: event.clientY,
			initialX: node.x,
			initialY: node.y,
			moved: false,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onNodePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		const current = boardRef.current;
		if (!drag || drag.kind !== "node" || !current) return;
		const dx = (event.clientX - drag.x) / current.viewport.scale;
		const dy = (event.clientY - drag.y) / current.viewport.scale;
		if (Math.abs(dx) + Math.abs(dy) < 1) return;
		if (!drag.moved) {
			history.current = [...history.current.slice(-49), documentOf(current)];
			future.current = [];
			setHistoryTick((value) => value + 1);
		}
		drag.moved = true;
		edit(
			(value) => ({
				...value,
				nodes: value.nodes.map((node) =>
					node.id === drag.id ? { ...node, x: drag.initialX + dx, y: drag.initialY + dy } : node,
				),
			}),
			false,
		);
	};
	const onNodePointerUp = () => {
		if (dragRef.current?.kind === "node") {
			if (dragRef.current.moved && dragRef.current.id) suppressNodeClick.current = dragRef.current.id;
			dragRef.current = undefined;
			void saveNow();
		}
	};
	const onNodeWheel = (event: ReactWheelEvent<HTMLElement>) => {
		const card = event.currentTarget;
		const horizontal = card.scrollWidth > card.clientWidth + 1;
		const vertical = card.scrollHeight > card.clientHeight + 1;
		if (event.shiftKey && horizontal && event.deltaY !== 0) {
			card.scrollLeft += event.deltaY;
			event.preventDefault();
			event.stopPropagation();
		} else if ((vertical && event.deltaY !== 0) || (horizontal && event.deltaX !== 0)) {
			event.stopPropagation();
		}
	};
	const onResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: CanvasNode, edge: ResizeEdge) => {
		if (event.button !== 0) return;
		closePaperPreview();
		event.preventDefault();
		event.stopPropagation();
		setSelectedNode(node.id);
		setSelectedEdge(undefined);
		setContextMenu(undefined);
		resizeRef.current = {
			id: node.id,
			edge,
			clientX: event.clientX,
			clientY: event.clientY,
			x: node.x,
			y: node.y,
			width: node.width,
			height: node.height,
			moved: false,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const drag = resizeRef.current;
		const current = boardRef.current;
		if (!drag || !current) return;
		event.stopPropagation();
		const dx = (event.clientX - drag.clientX) / current.viewport.scale;
		const dy = (event.clientY - drag.clientY) / current.viewport.scale;
		const fromLeft = drag.edge === "left";
		const fromTop = drag.edge === "top";
		const fromRight = drag.edge === "right" || drag.edge === "corner";
		const fromBottom = drag.edge === "bottom" || drag.edge === "corner";
		const width = fromLeft
			? clamp(drag.width - dx, 160, 1000)
			: fromRight
				? clamp(drag.width + dx, 160, 1000)
				: drag.width;
		const height = fromTop
			? clamp(drag.height - dy, 80, 1000)
			: fromBottom
				? clamp(drag.height + dy, 80, 1000)
				: drag.height;
		const x = fromLeft ? drag.x + drag.width - width : drag.x;
		const y = fromTop ? drag.y + drag.height - height : drag.y;
		const activeNode = current.nodes.find((node) => node.id === drag.id);
		if (
			!activeNode ||
			(width === activeNode.width && height === activeNode.height && x === activeNode.x && y === activeNode.y)
		)
			return;
		if (!drag.moved) {
			history.current = [...history.current.slice(-49), documentOf(current)];
			future.current = [];
			setHistoryTick((value) => value + 1);
		}
		drag.moved = true;
		edit(
			(value) => ({
				...value,
				nodes: value.nodes.map((node) => (node.id === drag.id ? { ...node, x, y, width, height } : node)),
			}),
			false,
		);
	};
	const onResizePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (!resizeRef.current) return;
		event.stopPropagation();
		const moved = resizeRef.current.moved;
		resizeRef.current = undefined;
		if (moved) void saveNow();
	};

	const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		closePaperPreview();
		if (
			(event.button !== 0 && event.button !== 1) ||
			(event.target as HTMLElement).closest("button, input, textarea, .research-canvas-edge")
		)
			return;
		const current = boardRef.current;
		if (!current) return;
		setSelectedNode(undefined);
		setSelectedEdge(undefined);
		dragRef.current = {
			kind: "pan",
			x: event.clientX,
			y: event.clientY,
			initialX: current.viewport.x,
			initialY: current.viewport.y,
			moved: false,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.kind !== "pan") {
			if (connectingFrom && !linkDragRef.current) {
				const current = boardRef.current;
				const source = current?.nodes.find((node) => node.id === connectingFrom);
				const rect = canvasRef.current?.getBoundingClientRect();
				if (source && current && rect) {
					const centerX = rect.left + current.viewport.x + (source.x + source.width / 2) * current.viewport.scale;
					const side = connectingSide ?? (event.clientX < centerX ? "left" : "right");
					updateLinkPreview(connectingFrom, side, event.clientX, event.clientY);
				}
			}
			return;
		}
		drag.moved = true;
		edit(
			(current) => ({
				...current,
				viewport: {
					...current.viewport,
					x: drag.initialX + event.clientX - drag.x,
					y: drag.initialY + event.clientY - drag.y,
				},
			}),
			false,
		);
	};
	const onCanvasPointerUp = () => {
		if (dragRef.current?.kind === "pan") {
			dragRef.current = undefined;
			void saveNow();
		}
	};
	const zoom = (scale: number, clientX?: number, clientY?: number) => {
		closePaperPreview();
		const rect = canvasRef.current?.getBoundingClientRect();
		if (!rect) return;
		edit((current) => {
			const nextScale = clamp(scale, 0.2, 3);
			const x = (clientX ?? rect.left + rect.width / 2) - rect.left;
			const y = (clientY ?? rect.top + rect.height / 2) - rect.top;
			const worldX = (x - current.viewport.x) / current.viewport.scale;
			const worldY = (y - current.viewport.y) / current.viewport.scale;
			return { ...current, viewport: { x: x - worldX * nextScale, y: y - worldY * nextScale, scale: nextScale } };
		}, false);
	};
	const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
		event.preventDefault();
		if (boardRef.current)
			zoom(boardRef.current.viewport.scale * Math.exp(-event.deltaY * 0.001), event.clientX, event.clientY);
	};
	const openBoard = async (id: string) => {
		if (id === boardRef.current?.id) return;
		if (!(await flush())) return;
		router.updateParams({ canvas: id, namespace });
	};
	const createBoard = async () => {
		if (!newTitle.trim()) return;
		if (!(await flush())) return;
		setBusy(true);
		try {
			const result = await api<{ canvas: Board }>("/api/canvases", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace, title: newTitle.trim() }),
			});
			setNewTitle("");
			await refreshBoards();
			router.updateParams({ canvas: result.canvas.id, namespace });
		} catch (reason) {
			setError(String(reason));
		} finally {
			setBusy(false);
		}
	};
	const showBoardDialog = (kind: "rename" | "delete", item: BoardSummary) => {
		setBoardMenu(undefined);
		setError("");
		setBoardDialog({ kind, item, title: item.id === boardRef.current?.id ? boardRef.current.title : item.title });
	};
	const renameBoard = async () => {
		if (!boardDialog || !boardDialog.title.trim() || busy) return;
		const { item, title } = boardDialog;
		setBusy(true);
		try {
			if (item.id === boardRef.current?.id && !(await flush())) return;
			const result = await api<{ canvas: Board }>(`/api/canvases/${encodeURIComponent(item.id)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					namespace,
					expectedRevision: item.id === boardRef.current?.id ? revision.current : item.revision,
					title: title.trim(),
				}),
			});
			if (item.id === boardRef.current?.id) {
				boardRef.current = result.canvas;
				setBoard(result.canvas);
				revision.current = result.canvas.revision;
				setSaveState("saved");
			}
			setBoardDialog(undefined);
			// Renaming reorders the list; retain the currently open canvas when the URL used the default item.
			if (!router.params.canvas && boardRef.current) router.updateParams({ canvas: boardRef.current.id, namespace });
			await refreshBoards();
		} catch (reason) {
			setError(String(reason));
		} finally {
			setBusy(false);
		}
	};
	const duplicateBoard = async (item: BoardSummary) => {
		if (busy) return;
		setBoardMenu(undefined);
		setBusy(true);
		try {
			if (!(await flush())) return;
			const result = await api<{ canvas: Board }>(`/api/canvases/${encodeURIComponent(item.id)}/copy`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					namespace,
					expectedRevision: item.id === boardRef.current?.id ? revision.current : item.revision,
				}),
			});
			await refreshBoards();
			router.updateParams({ canvas: result.canvas.id, namespace });
		} catch (reason) {
			setError(String(reason));
		} finally {
			setBusy(false);
		}
	};
	const deleteBoard = async (item: BoardSummary) => {
		if (busy) return;
		if (
			item.id === boardRef.current?.id &&
			openedNoteDirty.current &&
			!(await confirmCanvasAction("笔记有未保存的修改。放弃修改并删除画布吗？", true))
		)
			return;
		setBusy(true);
		try {
			// Await an already submitted save, then discard the deleted canvas's local draft.
			if (saving.current) await saving.current;
			const deletingActive = item.id === boardRef.current?.id;
			await api(`/api/canvases/${encodeURIComponent(item.id)}`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace, expectedRevision: deletingActive ? revision.current : item.revision }),
			});
			if (deletingActive) {
				boardRef.current = undefined;
				setBoard(undefined);
				revision.current = 0;
				changeVersion.current = 0;
				savedVersion.current = 0;
				history.current = [];
				future.current = [];
				setHistoryTick((value) => value + 1);
				setSelectedNode(undefined);
				setSelectedEdge(undefined);
				setEditingAuthor(undefined);
				setEditingTeam(undefined);
				setEditingText(undefined);
				setConnectingFrom(undefined);
				setConnectingSide(undefined);
				setLinkPreview(undefined);
				setContextMenu(undefined);
				setPicker(undefined);
				pendingNodePosition.current = undefined;
				pendingLinkFrom.current = undefined;
				dragRef.current = undefined;
				linkDragRef.current = undefined;
				resizeRef.current = undefined;
				closePaperPreview();
				setPaperDetails({});
				setPaperDetailErrors({});
				setPapers([]);
				setNotes([]);
				setOpenedNote(undefined);
				openedNoteDirty.current = false;
				setSaveState("saved");
			}
			setNodeClipboard((current) => (current?.boardId === item.id ? undefined : current));
			setBoardDialog(undefined);
			setBoards((items) => items.filter((candidate) => candidate.id !== item.id));
			const next = await refreshBoards();
			if (deletingActive || activeId === item.id) router.updateParams({ canvas: next[0]?.id ?? null, namespace });
		} catch (reason) {
			setError(String(reason));
		} finally {
			setBusy(false);
		}
	};
	const deleteSelection = () => {
		if (selectedNode) {
			deleteNode(selectedNode);
		} else if (selectedEdge) {
			deleteEdge(selectedEdge);
		}
	};
	const openPaper = async (paperId: string) => {
		if (!(await flush())) return;
		try {
			const details = await api<{ paper: PaperRecord; versions: PaperVersionView[] }>(
				`/api/papers/${encodeURIComponent(paperId)}?namespace=${encodeURIComponent(namespace)}`,
			);
			const version = details.versions.find((item) => item.isPreferred) ?? details.versions[0];
			if (!version) throw new Error("这篇论文尚无本地 PDF 版本");
			onOpenReader(readerVersionState(details.paper, namespace, version));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const pickerCollectionTree = useMemo(() => buildCollectionTree(pickerCollections), [pickerCollections]);
	const pickerCollectionRows = useMemo(
		() => visiblePickerCollections(pickerCollectionTree, pickerExpanded),
		[pickerCollectionTree, pickerExpanded],
	);
	const pickerNoteFolderRows = useMemo(
		() => visiblePickerNoteFolders(pickerFolders, pickerFolderExpanded),
		[pickerFolders, pickerFolderExpanded],
	);
	const pickerPaperPage = pickerPaperResults?.key === pickerPaperKey ? pickerPaperResults : undefined;
	const pickerNotePage = pickerNoteResults?.namespace === namespace ? pickerNoteResults : undefined;
	const noteQuery = pickerQuery.trim().toLocaleLowerCase();
	const pickerItems =
		picker === "paper"
			? (pickerPaperPage?.papers ?? [])
			: (pickerNotePage?.notes ?? []).filter(
					(item) =>
						(pickerFolder === "all" ||
							(pickerFolder === "__unfiled__" ? !item.folderId : item.folderId === pickerFolder)) &&
						(!noteQuery || `${item.title} ${item.folderPath ?? ""}`.toLocaleLowerCase().includes(noteQuery)),
				);
	const menuBoard = boards.find((item) => item.id === boardMenu?.id);
	const nodeManagerQuery = fullscreenNodeQuery.trim().toLocaleLowerCase();
	const visibleManagedNodes = (board?.nodes ?? []).filter(
		(node) =>
			(fullscreenNodeFilter === "all" || node.kind === fullscreenNodeFilter) &&
			(!nodeManagerQuery ||
				`${nodeCaption(node)} ${nodeTitle(node)} ${nodeNames[node.kind]}`
					.toLocaleLowerCase()
					.includes(nodeManagerQuery)),
	);

	return (
		<div className="research-canvas-page" ref={layoutRef}>
			{listOpen && (
				<aside className="research-canvas-list" inert={busy || !!boardDialog || !!actionDialog}>
					<div className="research-canvas-list-heading">
						<strong>关系画布</strong>
						<button type="button" onClick={() => setListOpen(false)} aria-label="收起画布列表">
							<X size={16} />
						</button>
					</div>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void createBoard();
						}}
						className="research-canvas-create"
					>
						<input
							value={newTitle}
							onChange={(event) => setNewTitle(event.target.value)}
							placeholder="新画布名称"
							aria-label="新画布名称"
							maxLength={120}
						/>
						<button type="submit" disabled={busy || !newTitle.trim()} aria-label="新建画布">
							<Plus size={17} />
						</button>
					</form>
					<div className="research-canvas-board-list" onScroll={() => setBoardMenu(undefined)}>
						{boards.map((item) => (
							<div
								key={item.id}
								className={`research-canvas-board-item${item.id === activeId ? " active" : ""}`}
							>
								<button
									type="button"
									className="research-canvas-board-open"
									onClick={() => void openBoard(item.id)}
								>
									<strong>{item.title}</strong>
									<small>{item.nodeCount} 个节点</small>
								</button>
								<button
									type="button"
									className="research-canvas-board-settings"
									aria-label={`画布「${item.title}」设置`}
									title="画布设置"
									aria-expanded={boardMenu?.id === item.id}
									aria-haspopup="menu"
									onClick={(event) => {
										if (boardMenu?.id === item.id) {
											setBoardMenu(undefined);
											return;
										}
										const rect = event.currentTarget.getBoundingClientRect();
										setBoardMenu({
											id: item.id,
											left: clamp(rect.right - 160, 8, window.innerWidth - 168),
											top: clamp(rect.bottom + 4, 8, window.innerHeight - 140),
										});
									}}
								>
									<MoreHorizontal size={18} />
								</button>
							</div>
						))}
					</div>
					<small className="research-canvas-namespace">个人库：{namespace}</small>
				</aside>
			)}
			<div className="research-canvas-main" inert={busy || !!boardDialog || !!actionDialog}>
				<header className="research-canvas-toolbar">
					{!listOpen && (
						<button
							type="button"
							className="research-canvas-list-toggle"
							onClick={() => setListOpen(true)}
							title="展开画布列表"
						>
							<BookOpen size={18} />
						</button>
					)}
					{board && (
						<>
							<div className="research-canvas-history">
								<button type="button" onClick={undo} disabled={!history.current.length} title="撤销 Ctrl+Z">
									<Undo2 size={16} />
								</button>
								<button type="button" onClick={redo} disabled={!future.current.length} title="重做 Ctrl+Y">
									<Redo2 size={16} />
								</button>
							</div>
							<span className={`research-canvas-save ${saveState}`}>
								{saveState === "saved"
									? "已保存"
									: saveState === "saving"
										? "保存中…"
										: saveState === "conflict"
											? "保存冲突"
											: "待保存"}
							</span>
							{!panelOpen && (
								<button type="button" onClick={() => setPanelOpen(true)} title="展开详情">
									<Maximize2 size={16} />
								</button>
							)}
						</>
					)}
					{board && (
						<button
							type="button"
							onClick={() => void toggleFullscreen()}
							title={isFullscreen ? "退出全屏画布" : "进入全屏画布"}
							aria-label={isFullscreen ? "退出全屏画布" : "进入全屏画布"}
							aria-pressed={isFullscreen}
						>
							{isFullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
						</button>
					)}
				</header>
				{error && (
					<div className="research-canvas-error" role="alert">
						{error}
						<button type="button" onClick={() => setError("")} aria-label="关闭错误">
							<X size={14} />
						</button>
					</div>
				)}
				{!board ? (
					<div className="research-canvas-empty">
						<Link2 size={34} />
						<h2>{boards.length ? "正在打开画布…" : "把论文、人物和想法放在一张画布上"}</h2>
						<p>先在左侧创建一张画布，再添加节点并建立关系。</p>
					</div>
				) : (
					<div
						className="research-canvas-stage"
						ref={canvasRef}
						onPointerDown={onCanvasPointerDown}
						onPointerMove={onCanvasPointerMove}
						onPointerUp={onCanvasPointerUp}
						onPointerCancel={onCanvasPointerUp}
						onContextMenu={onCanvasContextMenu}
						onWheel={onWheel}
						role="application"
						aria-label="研究关系画布"
					>
						<div
							className="research-canvas-world"
							style={{
								transform: `translate(${board.viewport.x}px, ${board.viewport.y}px) scale(${board.viewport.scale})`,
							}}
						>
							<svg className="research-canvas-connections" role="img" aria-label="节点关系">
								{board.edges.map((edge) => {
									const from = nodeMap.get(edge.from);
									const to = nodeMap.get(edge.to);
									return from && to ? (
										<Connection
											key={edge.id}
											edge={edge}
											from={from}
											to={to}
											fromHeight={from.height}
											toHeight={to.height}
											selected={edge.id === selectedEdge}
											onSelect={() => {
												setSelectedEdge(edge.id);
												setSelectedNode(undefined);
											}}
											onEdit={() => editEdge(edge)}
										/>
									) : null;
								})}
								{linkPreview &&
									(() => {
										const from = nodeMap.get(linkPreview.from);
										if (!from) return null;
										const startX = from.x + (linkPreview.side === "right" ? from.width : 0);
										const startY = from.y + from.height / 2;
										const bend = linkPreview.side === "right" ? 60 : -60;
										return (
											<path
												className="research-canvas-preview-line"
												d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${linkPreview.x - bend} ${linkPreview.y}, ${linkPreview.x} ${linkPreview.y}`}
											/>
										);
									})()}
							</svg>
							{board.nodes.map((node) => {
								const Icon = nodeIcons[node.kind];
								const missing =
									node.kind === "paper"
										? !paperById.has(node.entityId ?? "")
										: node.kind === "note"
											? !noteById.has(node.entityId ?? "")
											: node.kind === "agent"
												? !agentById.has(node.entityId ?? "")
												: false;
								return (
									<div
										key={node.id}
										className={`research-canvas-node-shell${node.id === connectingFrom ? " connecting" : ""}${node.id === linkPreview?.targetId ? " link-target" : ""}`}
										style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
										data-node-id={node.id}
									>
										<span className="research-canvas-node-kind research-canvas-node-caption">
											<Icon size={14} />
											{nodeCaption(node)}
										</span>
										{node.kind === "team" && editingTeam?.id === node.id ? (
											<form
												className="research-canvas-node kind-team editing"
												style={{ height: "100%" }}
												onWheel={onNodeWheel}
												onSubmit={(event) => {
													event.preventDefault();
													saveTeamEditing();
												}}
												onPointerDown={(event) => event.stopPropagation()}
												onClick={(event) => event.stopPropagation()}
												onKeyDown={(event) => {
													if (event.key === "Escape") {
														event.stopPropagation();
														setEditingTeam(undefined);
													}
												}}
											>
												<label>
													团队名称
													<input
														ref={teamNameInputRef}
														value={editingTeam.title}
														maxLength={300}
														onChange={(event) =>
															setEditingTeam(
																(current) => current && { ...current, title: event.target.value },
															)
														}
													/>
												</label>
												<label>
													所属机构
													<input
														value={editingTeam.institution}
														maxLength={300}
														onChange={(event) =>
															setEditingTeam(
																(current) => current && { ...current, institution: event.target.value },
															)
														}
													/>
												</label>
												<label>
													负责人／PI
													<input
														value={editingTeam.leaderName}
														maxLength={300}
														onChange={(event) =>
															setEditingTeam(
																(current) => current && { ...current, leaderName: event.target.value },
															)
														}
													/>
												</label>
												<label>
													研究方向
													<input
														value={editingTeam.researchAreas}
														maxLength={500}
														onChange={(event) =>
															setEditingTeam(
																(current) =>
																	current && { ...current, researchAreas: event.target.value },
															)
														}
													/>
												</label>
												<div className="research-canvas-team-member-editor">
													<span>团队成员</span>
													{editingTeam.members.map((member, index) => (
														<div
															className="research-canvas-team-member-entry"
															key={`${editingTeam.id}-member-${index}`}
														>
															<input
																aria-label={`团队成员 ${index + 1}`}
																value={member}
																maxLength={120}
																onChange={(event) =>
																	setEditingTeam(
																		(current) =>
																			current && {
																				...current,
																				members: current.members.map((name, position) =>
																					position === index ? event.target.value : name,
																				),
																			},
																	)
																}
															/>
															<button
																type="button"
																aria-label={`移除团队成员 ${index + 1}`}
																onClick={() =>
																	setEditingTeam(
																		(current) =>
																			current && {
																				...current,
																				members: current.members.filter(
																					(_, position) => position !== index,
																				),
																			},
																	)
																}
															>
																移除
															</button>
														</div>
													))}
													<button
														type="button"
														disabled={editingTeam.members.length >= 100}
														onClick={() =>
															setEditingTeam(
																(current) =>
																	current && {
																		...current,
																		members: [...current.members, ""],
																	},
															)
														}
													>
														＋ 添加成员
													</button>
												</div>
												<label>
													团队主页
													<input
														type="url"
														value={editingTeam.homepageUrl}
														placeholder="https://example.com"
														onChange={(event) =>
															setEditingTeam(
																(current) => current && { ...current, homepageUrl: event.target.value },
															)
														}
													/>
												</label>
												<label>
													团队简介
													<textarea
														value={editingTeam.content}
														maxLength={20000}
														rows={3}
														onChange={(event) =>
															setEditingTeam(
																(current) => current && { ...current, content: event.target.value },
															)
														}
													/>
												</label>
												<div className="research-canvas-author-actions">
													<button type="button" onClick={() => setEditingTeam(undefined)}>
														取消
													</button>
													<button type="submit">保存</button>
												</div>
											</form>
										) : node.kind === "author" && editingAuthor?.id === node.id ? (
											<form
												className="research-canvas-node kind-author editing"
												style={{ height: "100%" }}
												onWheel={onNodeWheel}
												onSubmit={(event) => {
													event.preventDefault();
													saveAuthorEditing();
												}}
												onPointerDown={(event) => event.stopPropagation()}
												onClick={(event) => event.stopPropagation()}
												onKeyDown={(event) => {
													if (event.key === "Escape") {
														event.stopPropagation();
														setEditingAuthor(undefined);
													}
												}}
											>
												<label>
													作者姓名：
													<input
														ref={authorNameInputRef}
														maxLength={300}
														value={editingAuthor.title}
														placeholder="请输入姓名"
														onChange={(event) =>
															setEditingAuthor(
																(current) => current && { ...current, title: event.target.value },
															)
														}
													/>
												</label>
												<label>
													研究领域：
													<input
														maxLength={300}
														value={editingAuthor.researchArea}
														placeholder="请输入研究领域"
														onChange={(event) =>
															setEditingAuthor(
																(current) =>
																	current && { ...current, researchArea: event.target.value },
															)
														}
													/>
												</label>
												<label>
													所属组织：
													<input
														maxLength={300}
														value={editingAuthor.organization}
														placeholder="请输入所属组织"
														onChange={(event) =>
															setEditingAuthor(
																(current) =>
																	current && { ...current, organization: event.target.value },
															)
														}
													/>
												</label>
												<label>
													姓名链接：
													<input
														type="url"
														value={editingAuthor.profileUrl}
														placeholder="https://example.com"
														onChange={(event) =>
															setEditingAuthor(
																(current) => current && { ...current, profileUrl: event.target.value },
															)
														}
													/>
												</label>
												<div className="research-canvas-author-actions">
													<button type="submit">保存</button>
													<button type="button" onClick={() => setEditingAuthor(undefined)}>
														取消
													</button>
												</div>
											</form>
										) : (
											// biome-ignore lint/a11y/useSemanticElements: The node contains links and rich text, so it cannot be a native button.
											<div
												className={`research-canvas-node kind-${node.kind}${node.id === selectedNode ? " selected" : ""}${node.id === connectingFrom ? " connecting" : ""}`}
												style={{ height: "100%" }}
												role="button"
												tabIndex={0}
												aria-label={`${nodeCaption(node)}：${nodeTitle(node)}`}
												onWheel={onNodeWheel}
												onPointerDown={(event) => onNodePointerDown(event, node)}
												onPointerMove={onNodePointerMove}
												onPointerUp={onNodePointerUp}
												onPointerCancel={onNodePointerUp}
												onClick={(event) => {
													if (suppressNodeClick.current === node.id) {
														suppressNodeClick.current = undefined;
														return;
													}
													chooseNode(node.id);
													if (node.kind === "paper") openPaperPreview(node, event.currentTarget);
													if (node.kind === "note") openNotePreview(node, event.currentTarget);
													if (node.kind === "agent" && node.entityId) setOpenedAgentId(node.entityId);
												}}
												onKeyDown={(event) => {
													if (event.target !== event.currentTarget) return;
													if (event.key === "Enter" || event.key === " ") {
														event.preventDefault();
														chooseNode(node.id);
														suppressNodeClick.current = undefined;
														if (node.kind === "paper") openPaperPreview(node, event.currentTarget);
														if (node.kind === "note") openNotePreview(node, event.currentTarget);
														if (node.kind === "agent" && node.entityId) setOpenedAgentId(node.entityId);
													} else if (event.key === "F2") {
														event.preventDefault();
														if (node.kind === "text") startTextEditing(node, event.currentTarget);
														else if (node.kind === "team") startTeamEditing(node);
														else if (node.kind === "agent") renameNode(node);
														else startAuthorEditing(node);
													}
												}}
												onDoubleClick={(event) => {
													event.preventDefault();
													if ((event.target as HTMLElement).closest("a")) return;
													if (node.kind === "text") startTextEditing(node, event.currentTarget);
													else if (node.kind === "team") startTeamEditing(node);
													else if (node.kind === "agent" && node.entityId) setOpenedAgentId(node.entityId);
													else startAuthorEditing(node);
												}}
											>
												{node.kind === "team" ? (
													<span className="research-canvas-team-fields">
														<strong>{nodeTitle(node)}</strong>
														{node.teamDetails?.institution && (
															<span>所属机构：{node.teamDetails.institution}</span>
														)}
														{(teamLeaderNames(node.id) || node.teamDetails?.leaderName) && (
															<span>
																负责人／PI：{teamLeaderNames(node.id) || node.teamDetails?.leaderName}
															</span>
														)}
														{node.teamDetails?.researchAreas && (
															<span>研究方向：{node.teamDetails.researchAreas}</span>
														)}
														{teamMemberNames(node).length > 0 && (
															<span>团队成员：{teamMemberNames(node).join("、")}</span>
														)}
														{node.teamDetails?.homepageUrl && (
															<a
																href={node.teamDetails.homepageUrl}
																target="_blank"
																rel="noopener noreferrer"
																onPointerDown={(event) => event.stopPropagation()}
																onClick={(event) => event.stopPropagation()}
																onDoubleClick={(event) => event.stopPropagation()}
															>
																团队主页
															</a>
														)}
													</span>
												) : node.kind === "author" ? (
													<span className="research-canvas-author-fields">
														<span className="research-canvas-author-row">
															<span>作者姓名：</span>
															{node.title && node.title !== "作者姓名" ? (
																node.authorDetails?.profileUrl ? (
																	<a
																		href={node.authorDetails.profileUrl}
																		target="_blank"
																		rel="noopener noreferrer"
																		onPointerDown={(event) => event.stopPropagation()}
																		onClick={(event) => event.stopPropagation()}
																		onDoubleClick={(event) => event.stopPropagation()}
																	>
																		<strong>{node.title}</strong>
																	</a>
																) : (
																	<strong>{node.title}</strong>
																)
															) : (
																<em>请输入姓名</em>
															)}
														</span>
														<span className="research-canvas-author-row">
															<span>研究领域：</span>
															{node.authorDetails?.researchArea ? (
																<span>{node.authorDetails.researchArea}</span>
															) : (
																<em>请输入研究领域</em>
															)}
														</span>
														<span className="research-canvas-author-row">
															<span>所属组织：</span>
															{node.authorDetails?.organization ? (
																<span>{node.authorDetails.organization}</span>
															) : (
																<em>请输入所属组织</em>
															)}
														</span>
													</span>
												) : node.kind === "text" ? (
													<CanvasTextView document={canvasTextDocument(node)} />
												) : (
													<strong>{nodeTitle(node)}</strong>
												)}
												{node.kind === "paper" && (
													<small>
														{paperById
															.get(node.entityId ?? "")
															?.authors.slice(0, 3)
															.join("、") ?? ""}
													</small>
												)}
												{node.kind === "agent" && agentById.get(node.entityId ?? "") && (
													<div className="research-canvas-agent-meta">
														<span>
															{(() => {
																const status = agentById.get(node.entityId!)!.status;
																return status === "running"
																	? "运行中"
																	: status === "stopping"
																		? "正在停止"
																		: status === "error"
																			? "出错"
																			: "可继续对话";
															})()}
														</span>
														{agentById.get(node.entityId!)!.pendingUIRequests > 0 && (
															<span className="attention">
																待处理 {agentById.get(node.entityId!)!.pendingUIRequests} 项
															</span>
														)}
														<time dateTime={agentById.get(node.entityId!)!.updatedAt}>
															{new Date(agentById.get(node.entityId!)!.updatedAt).toLocaleString(
																"zh-CN",
															)}
														</time>
													</div>
												)}
												{node.kind !== "author" &&
													node.kind !== "text" &&
													node.kind !== "team" &&
													node.kind !== "agent" &&
													node.content && (
														<span className="research-canvas-node-content">{node.content}</span>
													)}
												{missing && <small className="missing">来源已缺失</small>}
											</div>
										)}
										{(["left", "right"] as LinkSide[]).map((side) => (
											<button
												key={side}
												type="button"
												className={`research-canvas-link-handle ${side}${node.id === linkPreview?.targetId && side === linkPreview.targetSide ? " candidate" : ""}`}
												aria-label={`从${nodeTitle(node)}的${side === "left" ? "左" : "右"}侧连线`}
												title="拖到其他节点连线；在空白处松开可新建节点"
												onPointerDown={(event) => onLinkHandlePointerDown(event, node.id, side)}
												onPointerMove={onLinkHandlePointerMove}
												onPointerUp={onLinkHandlePointerUp}
												onPointerCancel={() => {
													linkDragRef.current = undefined;
													setLinkPreview(undefined);
													setConnectingFrom(undefined);
													setConnectingSide(undefined);
												}}
												data-side={side}
												onClick={() => onLinkHandleClick(node.id, side)}
											>
												<Plus size={17} />
											</button>
										))}
										{(["left", "right", "top", "bottom", "corner"] as ResizeEdge[]).map((edge) => (
											<button
												key={edge}
												type="button"
												className={`research-canvas-resize-handle ${edge}`}
												aria-label={`调整${nodeNames[node.kind]}节点大小`}
												title="拖动调整节点大小"
												tabIndex={-1}
												onPointerDown={(event) => onResizePointerDown(event, node, edge)}
												onPointerMove={onResizePointerMove}
												onPointerUp={onResizePointerUp}
												onPointerCancel={onResizePointerUp}
											/>
										))}
									</div>
								);
							})}
						</div>
						{editingText && nodeMap.get(editingText.id)?.kind === "text" && (
							<CanvasTextEditor
								key={editingText.id}
								document={canvasTextDocument(nodeMap.get(editingText.id)!)}
								portal={editingText.portal}
								position={editingText.position}
								onSave={(content) => saveTextEditing(editingText.id, content)}
								onCancel={() => setEditingText(undefined)}
							/>
						)}
						{openedPaper && paperById.has(openedPaper.paperId) && (
							<CanvasPaperPreview
								key={openedPaper.nodeId}
								paper={paperById.get(openedPaper.paperId)!}
								details={paperDetails[paperDetailKey(openedPaper.paperId)]}
								loading={
									!paperDetails[paperDetailKey(openedPaper.paperId)] &&
									!paperDetailErrors[paperDetailKey(openedPaper.paperId)]
								}
								error={paperDetailErrors[paperDetailKey(openedPaper.paperId)]}
								style={{
									left: openedPaper.left,
									top: openedPaper.top,
									width: openedPaper.width,
									maxHeight: openedPaper.maxHeight,
								}}
								onClose={closePaperPreview}
							/>
						)}
						{openedNote && nodeMap.has(openedNote.nodeId) && noteById.has(openedNote.noteId) && (
							<CanvasNotePreview
								key={openedNote.nodeId}
								namespace={namespace}
								noteId={openedNote.noteId}
								summary={noteById.get(openedNote.noteId)!}
								placement={{
									left: openedNote.left,
									top: openedNote.top,
									width: openedNote.width,
									height: openedNote.maxHeight,
								}}
								onDirtyChange={(dirty) => {
									openedNoteDirty.current = dirty;
								}}
								onSaved={(note: ResearchNote) =>
									setNotes((current) => current.map((item) => (item.id === note.id ? note : item)))
								}
								confirmAction={confirmCanvasAction}
								onClose={() => {
									openedNoteDirty.current = false;
									setOpenedNote(undefined);
								}}
							/>
						)}
						{contextMenu && (
							<div
								ref={contextMenuRef}
								className="research-canvas-context-menu"
								role="menu"
								aria-label="画布操作"
								style={{ left: contextMenu.x, top: contextMenu.y }}
							>
								{contextMenu.view === "root" ? (
									<>
										<button
											type="button"
											role="menuitem"
											aria-haspopup="menu"
											onClick={() => setContextMenu((current) => current && { ...current, view: "nodes" })}
										>
											<Plus size={16} />
											添加节点
											<ChevronRight className="research-canvas-context-trailing" size={15} />
										</button>
										<button
											type="button"
											role="menuitem"
											disabled={!nodeClipboard || nodeClipboard.namespace !== namespace}
											onClick={() => {
												if (!nodeClipboard || !contextMenu) return;
												placeNodeCopy(
													nodeClipboard.node,
													contextMenu.worldX - nodeClipboard.node.width / 2,
													contextMenu.worldY - nodeClipboard.node.height / 2,
												);
											}}
										>
											<ClipboardPaste size={16} />
											粘贴节点
										</button>
										<div className="research-canvas-context-separator" />
										<button
											type="button"
											role="menuitem"
											disabled={!history.current.length}
											onClick={() => {
												setContextMenu(undefined);
												undo();
											}}
										>
											<Undo2 size={16} />
											撤销
											<kbd>Ctrl+Z</kbd>
										</button>
										<button
											type="button"
											role="menuitem"
											disabled={!future.current.length}
											onClick={() => {
												setContextMenu(undefined);
												redo();
											}}
										>
											<Redo2 size={16} />
											重做
											<kbd>Ctrl+Y</kbd>
										</button>
									</>
								) : contextMenu.view === "node" ? (
									contextNode && (
										<>
											<div className="research-canvas-context-heading">
												{nodeNames[contextNode.kind]}节点
											</div>
											<button type="button" role="menuitem" onClick={() => copyNode(contextNode)}>
												<Copy size={16} />
												复制节点
											</button>
											<button
												type="button"
												role="menuitem"
												onClick={() => placeNodeCopy(contextNode, contextNode.x + 40, contextNode.y + 40)}
											>
												<Files size={16} />
												创建副本
											</button>
											<button type="button" role="menuitem" onClick={() => renameNode(contextNode)}>
												<Pencil size={16} />
												重命名
											</button>
											<div className="research-canvas-context-separator" />
											<button
												type="button"
												role="menuitem"
												className="research-canvas-context-danger"
												onClick={() => deleteNode(contextNode.id)}
											>
												<Trash2 size={16} />
												删除节点
											</button>
										</>
									)
								) : contextMenu.view === "edge" ? (
									contextEdge && (
										<>
											<div className="research-canvas-context-heading">连线</div>
											<button type="button" role="menuitem" onClick={() => editEdge(contextEdge)}>
												<Pencil size={16} />
												编辑连线
											</button>
											<div className="research-canvas-context-separator" />
											<button
												type="button"
												role="menuitem"
												className="research-canvas-context-danger"
												onClick={() => deleteEdge(contextEdge.id)}
											>
												<Trash2 size={16} />
												删除连线
											</button>
										</>
									)
								) : (
									<>
										{!contextMenu.linkFrom && (
											<>
												<button
													type="button"
													role="menuitem"
													onClick={() =>
														setContextMenu((current) => current && { ...current, view: "root" })
													}
												>
													<ChevronLeft size={16} />
													返回
												</button>
												<div className="research-canvas-context-separator" />
											</>
										)}
										<div className="research-canvas-context-heading">
											{contextMenu.linkFrom ? "从此节点新建并连线" : "添加节点"}
										</div>
										{(contextMenu.linkFrom
											? (["text", "author", "team", "paper", "note", "agent"] as NodeKind[])
											: (["paper", "note", "text", "author", "team", "agent"] as NodeKind[])
										).map((kind) => {
											const Icon = nodeIcons[kind];
											return (
												<button
													key={kind}
													type="button"
													role="menuitem"
													onClick={() => addNodeFromContextMenu(kind)}
												>
													<Icon size={16} />
													{nodeNames[kind]}
												</button>
											);
										})}
										{!contextMenu.linkFrom && (
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setContextMenu(undefined);
													setAgentPickerOpen(true);
													void refreshAgentSessions();
												}}
											>
												<Bot size={16} />
												找回画布会话
											</button>
										)}
									</>
								)}
							</div>
						)}
						{connectingFrom && (
							<div className="research-canvas-hint">拖到目标节点连线，或在空白处松开新建 · Esc 取消</div>
						)}
						<div className="research-canvas-zoom">
							<button type="button" onClick={() => zoom(board.viewport.scale * 0.8)} aria-label="缩小">
								<ZoomOut size={17} />
							</button>
							<span>{Math.round(board.viewport.scale * 100)}%</span>
							<button type="button" onClick={() => zoom(board.viewport.scale * 1.25)} aria-label="放大">
								<ZoomIn size={17} />
							</button>
							<button
								type="button"
								onClick={() => edit((current) => ({ ...current, viewport: { x: 0, y: 0, scale: 1 } }), false)}
								title="重置视图"
							>
								<Focus size={17} />
							</button>
						</div>
						<div className="research-canvas-help">
							<Hand size={13} />
							拖动空白平移 · 滚轮缩放 · 拖动卡片排列 · 拖动边缘调整大小
						</div>
					</div>
				)}
				{isFullscreen && board && (
					<div className="research-canvas-fullscreen-ui">
						<nav className="research-canvas-fullscreen-rail" aria-label="全屏画布工具">
							<button
								type="button"
								className={fullscreenAddOpen ? "active" : ""}
								aria-label="添加节点"
								title="添加节点"
								aria-expanded={fullscreenAddOpen}
								onClick={() => {
									setFullscreenAddOpen((open) => !open);
									setFullscreenNodesOpen(false);
									setFullscreenNodeMenuId(undefined);
								}}
							>
								<Plus size={26} />
							</button>
							<button
								type="button"
								className={fullscreenNodesOpen ? "active" : ""}
								aria-label="节点管理"
								title="节点管理"
								aria-expanded={fullscreenNodesOpen}
								onClick={() => {
									setFullscreenNodesOpen((open) => !open);
									setFullscreenAddOpen(false);
									setFullscreenNodeMenuId(undefined);
								}}
							>
								<ListTree size={22} />
							</button>
						</nav>
						{fullscreenAddOpen && (
							<div className="research-canvas-fullscreen-add-menu" role="menu" aria-label="添加节点类型">
								<strong>添加节点</strong>
								{(["paper", "note", "text", "author", "team", "agent"] as NodeKind[]).map((kind) => {
									const Icon = nodeIcons[kind];
									return (
										<button
											key={kind}
											type="button"
											role="menuitem"
											onClick={() => addNodeFromFullscreen(kind)}
										>
											<Icon size={17} />
											{nodeNames[kind]}
										</button>
									);
								})}
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										setFullscreenAddOpen(false);
										setAgentPickerOpen(true);
										void refreshAgentSessions();
									}}
								>
									<Bot size={17} />
									找回画布会话
								</button>
							</div>
						)}
						{fullscreenNodesOpen && (
							<aside className="research-canvas-fullscreen-nodes" aria-label="节点管理">
								<div className="research-canvas-fullscreen-nodes-heading">
									<div>
										<strong>节点管理</strong>
										<small>{board.nodes.length} 个节点</small>
									</div>
									<button
										type="button"
										aria-label="关闭节点管理"
										onClick={() => setFullscreenNodesOpen(false)}
									>
										<X size={18} />
									</button>
								</div>
								<fieldset className="research-canvas-fullscreen-node-filters">
									<legend>分类</legend>
									{(["all", ...nodeManagerKinds] as const).map((kind) => (
										<button
											key={kind}
											type="button"
											className={fullscreenNodeFilter === kind ? "active" : ""}
											aria-pressed={fullscreenNodeFilter === kind}
											onClick={() => {
												setFullscreenNodeFilter(kind);
												setFullscreenNodeMenuId(undefined);
											}}
										>
											{kind === "all" ? "全部" : nodeNames[kind]}
										</button>
									))}
								</fieldset>
								<label className="research-canvas-fullscreen-node-search">
									<Search size={16} aria-hidden="true" />
									<input
										type="search"
										value={fullscreenNodeQuery}
										onChange={(event) => setFullscreenNodeQuery(event.target.value)}
										placeholder="搜索节点名称"
										aria-label="搜索节点名称"
									/>
								</label>
								<div className="research-canvas-fullscreen-node-list">
									{board.nodes.length === 0 && <p>画布中还没有节点。点击左侧 + 添加。</p>}
									{board.nodes.length > 0 && visibleManagedNodes.length === 0 && <p>没有符合条件的节点。</p>}
									{visibleManagedNodes.map((node) => {
										const Icon = nodeIcons[node.kind];
										const name = nodeCaption(node);
										const title = nodeTitle(node).trim();
										return (
											<div
												key={node.id}
												className={`research-canvas-fullscreen-node-item${selectedNode === node.id ? " selected" : ""}`}
											>
												<div className="research-canvas-fullscreen-node-row">
													<button
														type="button"
														className="research-canvas-fullscreen-node-jump"
														onClick={() => jumpToNode(node)}
														title={`${name}${title ? ` · ${title}` : ""}`}
													>
														<span className="research-canvas-fullscreen-node-icon">
															<Icon size={18} />
														</span>
														<span className="research-canvas-fullscreen-node-text">
															<span className="research-canvas-fullscreen-node-title">{name}</span>
															{title && <small>{title}</small>}
														</span>
													</button>
													<button
														type="button"
														className="research-canvas-fullscreen-node-settings"
														aria-label={`节点「${name}」设置`}
														aria-expanded={fullscreenNodeMenuId === node.id}
														onClick={() =>
															setFullscreenNodeMenuId((id) => (id === node.id ? undefined : node.id))
														}
													>
														<MoreHorizontal size={19} />
													</button>
												</div>
												{fullscreenNodeMenuId === node.id && (
													<div
														className="research-canvas-fullscreen-node-menu"
														role="menu"
														aria-label={`节点「${name}」设置`}
													>
														<button
															type="button"
															role="menuitem"
															onClick={() => {
																setFullscreenNodeMenuId(undefined);
																renameNode(node);
															}}
														>
															<Pencil size={15} /> 重命名
														</button>
														<button
															type="button"
															role="menuitem"
															className="danger"
															onClick={() => deleteNode(node.id)}
														>
															<Trash2 size={15} /> 删除节点
														</button>
													</div>
												)}
											</div>
										);
									})}
								</div>
							</aside>
						)}
					</div>
				)}
			</div>
			{board && panelOpen && !openedAgentId && (
				<aside className="research-canvas-inspector" inert={busy || !!boardDialog || !!actionDialog}>
					<div className="research-canvas-inspector-heading">
						<strong>{selected ? nodeCaption(selected) : edgeSelected ? "关系" : "画布详情"}</strong>
						<button type="button" onClick={() => setPanelOpen(false)} aria-label="收起详情">
							<X size={16} />
						</button>
					</div>
					{selected ? (
						<>
							<label>
								{selected.kind === "author" ? "作者姓名" : "标题"}
								<input
									value={
										selected.kind === "author" && selected.title === "作者姓名" ? "" : nodeTitle(selected)
									}
									placeholder={selected.kind === "author" ? "请输入姓名" : undefined}
									disabled={
										selected.kind === "paper" ||
										selected.kind === "note" ||
										selected.kind === "text" ||
										selected.kind === "agent"
									}
									maxLength={300}
									onChange={(event) =>
										edit((current) => ({
											...current,
											nodes: current.nodes.map((node) =>
												node.id === selected.id ? { ...node, title: event.target.value } : node,
											),
										}))
									}
								/>
							</label>
							{selected.kind === "author" && (
								<>
									<label>
										研究领域
										<input
											value={selected.authorDetails?.researchArea ?? ""}
											maxLength={300}
											onChange={(event) =>
												edit((current) => ({
													...current,
													nodes: current.nodes.map((node) =>
														node.id === selected.id
															? {
																	...node,
																	authorDetails: {
																		researchArea: event.target.value,
																		organization: node.authorDetails?.organization ?? "",
																		...(node.authorDetails?.profileUrl
																			? { profileUrl: node.authorDetails.profileUrl }
																			: {}),
																	},
																}
															: node,
													),
												}))
											}
										/>
									</label>
									<label>
										所属组织
										<input
											value={selected.authorDetails?.organization ?? ""}
											maxLength={300}
											onChange={(event) =>
												edit((current) => ({
													...current,
													nodes: current.nodes.map((node) =>
														node.id === selected.id
															? {
																	...node,
																	authorDetails: {
																		researchArea: node.authorDetails?.researchArea ?? "",
																		organization: event.target.value,
																		...(node.authorDetails?.profileUrl
																			? { profileUrl: node.authorDetails.profileUrl }
																			: {}),
																	},
																}
															: node,
													),
												}))
											}
										/>
									</label>
									<label>
										姓名链接
										<input
											key={`${selected.id}:${selected.authorDetails?.profileUrl ?? ""}`}
											type="url"
											defaultValue={selected.authorDetails?.profileUrl ?? ""}
											placeholder="https://example.com"
											onBlur={(event) => {
												const url = event.target.value.trim();
												if (url && !validCanvasUrl(url)) {
													setError("作者姓名链接必须是完整的 http 或 https 地址。");
													event.target.value = selected.authorDetails?.profileUrl ?? "";
													return;
												}
												if (url === (selected.authorDetails?.profileUrl ?? "")) return;
												edit((current) => ({
													...current,
													nodes: current.nodes.map((node) =>
														node.id === selected.id
															? {
																	...node,
																	authorDetails: {
																		researchArea: node.authorDetails?.researchArea ?? "",
																		organization: node.authorDetails?.organization ?? "",
																		...(url ? { profileUrl: url } : {}),
																	},
																}
															: node,
													),
												}));
											}}
										/>
									</label>
								</>
							)}
							{selected.kind === "team" && (
								<>
									<label>
										所属机构
										<input
											value={selected.teamDetails?.institution ?? ""}
											maxLength={300}
											onChange={(event) =>
												updateTeamDetails(selected.id, { institution: event.target.value })
											}
										/>
									</label>
									<label>
										负责人／PI
										<input
											value={selected.teamDetails?.leaderName ?? ""}
											maxLength={300}
											onChange={(event) =>
												updateTeamDetails(selected.id, { leaderName: event.target.value })
											}
										/>
									</label>
									{teamLeaderNames(selected.id) && (
										<p className="research-canvas-detail-note">
											当前由作者连线显示：{teamLeaderNames(selected.id)}
										</p>
									)}
									<label>
										研究方向
										<input
											value={selected.teamDetails?.researchAreas ?? ""}
											maxLength={500}
											onChange={(event) =>
												updateTeamDetails(selected.id, { researchAreas: event.target.value })
											}
										/>
									</label>
									<div className="research-canvas-team-members-inspector">
										<strong>团队成员</strong>
										{(selected.teamDetails?.members ?? []).map((member, index) => (
											<div
												className="research-canvas-team-member-entry"
												key={`${selected.id}-member-${index}`}
											>
												<span>{member}</span>
												<button
													type="button"
													aria-label={`移除成员 ${member}`}
													onClick={() =>
														updateTeamDetails(selected.id, {
															members: (selected.teamDetails?.members ?? []).filter(
																(_, position) => position !== index,
															),
														})
													}
												>
													移除
												</button>
											</div>
										))}
										{teamMemberNames(selected).filter(
											(name) => !(selected.teamDetails?.members ?? []).includes(name),
										).length > 0 && (
											<p>
												作者连线／负责人：
												{teamMemberNames(selected)
													.filter((name) => !(selected.teamDetails?.members ?? []).includes(name))
													.join("、")}
											</p>
										)}
										<div className="research-canvas-team-member-entry">
											<input
												aria-label="新团队成员姓名"
												value={teamMemberDraft}
												maxLength={120}
												placeholder="输入姓名"
												onChange={(event) => setTeamMemberDraft(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === "Enter") {
														event.preventDefault();
														addTeamMember(selected);
													}
												}}
											/>
											<button
												type="button"
												disabled={!teamMemberDraft.trim()}
												onClick={() => addTeamMember(selected)}
											>
												添加
											</button>
										</div>
									</div>
									<label>
										团队主页
										<input
											key={`${selected.id}:${selected.teamDetails?.homepageUrl ?? ""}`}
											type="url"
											defaultValue={selected.teamDetails?.homepageUrl ?? ""}
											placeholder="https://example.com"
											onBlur={(event) => {
												const url = event.target.value.trim();
												if (url && !validCanvasUrl(url)) {
													setError("团队主页必须是完整的 http 或 https 地址。");
													event.target.value = selected.teamDetails?.homepageUrl ?? "";
													return;
												}
												if (url !== (selected.teamDetails?.homepageUrl ?? ""))
													updateTeamDetails(selected.id, { homepageUrl: url || undefined });
											}}
										/>
									</label>
								</>
							)}
							{selected.kind === "text" && (
								<button
									type="button"
									className="research-canvas-action"
									onClick={() => startTextEditing(selected)}
								>
									<Pencil size={15} /> 编辑文本与格式
								</button>
							)}
							{selected.kind === "agent" && (
								<>
									<button
										type="button"
										className="research-canvas-action"
										onClick={() => setOpenedAgentId(selected.entityId)}
									>
										<Bot size={15} /> 打开对话
									</button>
									<button
										type="button"
										className="research-canvas-action"
										onClick={() => void renameAgentSession(selected)}
									>
										<Pencil size={15} /> 重命名会话
									</button>
									<p className="research-canvas-detail-note">移除节点后，会话仍可从本画布的会话列表找回。</p>
								</>
							)}
							{selected.kind !== "paper" &&
								selected.kind !== "note" &&
								selected.kind !== "text" &&
								selected.kind !== "agent" &&
								(selected.kind !== "author" || !!selected.content) && (
									<label>
										{selected.kind === "author"
											? "旧版补充内容"
											: selected.kind === "team"
												? "团队简介"
												: "内容"}
										<textarea
											value={selected.content ?? ""}
											rows={8}
											maxLength={20000}
											placeholder="写下你想记录的内容…"
											onChange={(event) =>
												edit((current) => ({
													...current,
													nodes: current.nodes.map((node) =>
														node.id === selected.id ? { ...node, content: event.target.value } : node,
													),
												}))
											}
										/>
									</label>
								)}
							{selected.kind === "paper" && (
								<>
									<p className="research-canvas-detail-note">
										{paperById.get(selected.entityId ?? "")?.authors.join("、") ?? "个人库中已找不到这篇论文"}
									</p>
									<button
										type="button"
										className="research-canvas-action"
										disabled={!paperById.has(selected.entityId ?? "")}
										onClick={() => void openPaper(selected.entityId ?? "")}
									>
										阅读论文 <ArrowRight size={15} />
									</button>
								</>
							)}
							{selected.kind === "note" && (
								<button
									type="button"
									className="research-canvas-action"
									onClick={() => router.navigate("research", { namespace, noteId: selected.entityId ?? "" })}
								>
									打开个人笔记 <ArrowRight size={15} />
								</button>
							)}
							<button
								type="button"
								className="research-canvas-action"
								onClick={() => setConnectingFrom(selected.id)}
							>
								<Link2 size={16} />
								从此节点连线
							</button>
							<button type="button" className="research-canvas-danger" onClick={deleteSelection}>
								<Trash2 size={16} />
								从画布移除
							</button>
						</>
					) : edgeSelected ? (
						<>
							<p className="research-canvas-detail-note">
								{nodeMap.get(edgeSelected.from)?.title} → {nodeMap.get(edgeSelected.to)?.title}
							</p>
							<label>
								关系名称
								<input
									value={edgeSelected.label}
									maxLength={120}
									onChange={(event) =>
										edit((current) => ({
											...current,
											edges: current.edges.map((edge) =>
												edge.id === edgeSelected.id ? { ...edge, label: event.target.value } : edge,
											),
										}))
									}
								/>
							</label>
							<label>
								关系依据
								<textarea
									value={edgeSelected.evidence ?? ""}
									rows={6}
									maxLength={4000}
									placeholder="例如：论文第 4 页，或你的判断依据"
									onChange={(event) =>
										edit((current) => ({
											...current,
											edges: current.edges.map((edge) =>
												edge.id === edgeSelected.id ? { ...edge, evidence: event.target.value } : edge,
											),
										}))
									}
								/>
							</label>
							<button type="button" className="research-canvas-danger" onClick={deleteSelection}>
								<Trash2 size={16} />
								删除连线
							</button>
						</>
					) : (
						<>
							<label>
								画布名称
								<input
									value={board.title}
									maxLength={120}
									onChange={(event) => edit((current) => ({ ...current, title: event.target.value }))}
								/>
							</label>
							<p className="research-canvas-detail-note">
								{board.nodes.length} 个节点 · {board.edges.length} 条关系
							</p>
							<button
								type="button"
								className="research-canvas-danger"
								onClick={() =>
									showBoardDialog("delete", {
										id: board.id,
										title: board.title,
										revision: revision.current,
										updatedAt: board.updatedAt,
										nodeCount: board.nodes.length,
									})
								}
							>
								<Trash2 size={16} />
								删除这张画布
							</button>
						</>
					)}
				</aside>
			)}
			{board && openedAgentId && (
				<aside className="research-canvas-agent-panel" aria-label="画布 Agent 对话">
					<div className="research-canvas-agent-panel-heading">
						<div>
							<Bot size={18} />
							<strong>{agentById.get(openedAgentId)?.title ?? "Agent 对话"}</strong>
						</div>
						<button type="button" onClick={() => setOpenedAgentId(undefined)} aria-label="关闭 Agent 对话">
							<X size={18} />
						</button>
					</div>
					<Suspense fallback={<div className="research-canvas-agent-loading">正在加载对话…</div>}>
						<AgentPage
							key={`${board.id}:${openedAgentId}`}
							embedded
							canvasContext={{ namespace, canvasId: board.id }}
							canvasNodes={connectedAgentNodes}
							focusSessionId={openedAgentId}
							confirmAction={confirmCanvasAction}
							promptAction={promptCanvasAction}
						/>
					</Suspense>
				</aside>
			)}
			{board && agentPickerOpen && (
				<div
					className="research-canvas-agent-picker-backdrop"
					onPointerDown={(event) => {
						if (event.target === event.currentTarget) setAgentPickerOpen(false);
					}}
				>
					<section
						className="research-canvas-agent-picker"
						role="dialog"
						aria-modal="true"
						aria-label="本画布的 Agent 会话"
					>
						<header>
							<div>
								<strong>本画布的 Agent 会话</strong>
								<small>移除节点不会删除会话，可以在这里重新添加。</small>
							</div>
							<button type="button" onClick={() => setAgentPickerOpen(false)} aria-label="关闭">
								<X size={18} />
							</button>
						</header>
						<div className="research-canvas-agent-picker-list">
							{agentSessions.length === 0 && <p>暂无会话。点击“添加 Agent 对话”新建。</p>}
							{agentSessions.map((session) => {
								const attached = board.nodes.some(
									(node) => node.kind === "agent" && node.entityId === session.id,
								);
								return (
									<div className="research-canvas-agent-picker-row" key={session.id}>
										<div>
											<strong>{session.title}</strong>
											<small>
												{attached ? "已在画布上" : "已从画布移除"} ·{" "}
												{session.status === "running" ? "运行中" : "可继续对话"} ·{" "}
												{new Date(session.updatedAt).toLocaleString("zh-CN")}
											</small>
										</div>
										<button type="button" onClick={() => attachAgentSession(session)}>
											{attached ? "打开" : "重新添加"}
										</button>
										<button
											type="button"
											className="danger"
											onClick={() => void permanentlyDeleteAgentSession(session)}
											aria-label={`永久删除 ${session.title}`}
											title="永久删除会话及历史"
										>
											<Trash2 size={16} />
										</button>
									</div>
								);
							})}
						</div>
					</section>
				</div>
			)}
			{editingEdge && (
				<div className="research-canvas-board-dialog-backdrop">
					<form
						className="research-canvas-board-dialog research-canvas-edge-dialog"
						role="dialog"
						aria-modal="true"
						aria-label="编辑连线"
						onSubmit={(event) => {
							event.preventDefault();
							saveEdgeEditing();
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.stopPropagation();
								setEditingEdge(undefined);
							}
						}}
					>
						<h2>编辑连线</h2>
						<p className="research-canvas-detail-note">
							{nodeMap.get(editingEdgeRecord?.from ?? "")?.title ?? "节点"} →{" "}
							{nodeMap.get(editingEdgeRecord?.to ?? "")?.title ?? "节点"}
						</p>
						<label>
							关系名称
							<input
								ref={edgeLabelInputRef}
								value={editingEdge.label}
								maxLength={120}
								onChange={(event) =>
									setEditingEdge((current) => current && { ...current, label: event.target.value })
								}
							/>
						</label>
						<label>
							关系依据
							<textarea
								value={editingEdge.evidence}
								rows={6}
								maxLength={4000}
								placeholder="例如：论文第 4 页，或你的判断依据"
								onChange={(event) =>
									setEditingEdge((current) => current && { ...current, evidence: event.target.value })
								}
							/>
						</label>
						<div className="research-canvas-board-dialog-actions">
							<button type="button" onClick={() => setEditingEdge(undefined)}>
								取消
							</button>
							<button type="submit" className="primary">
								保存
							</button>
						</div>
					</form>
				</div>
			)}
			{boardMenu &&
				menuBoard &&
				createPortal(
					<div
						ref={boardMenuRef}
						className="research-canvas-board-menu"
						role="menu"
						aria-label={`画布「${menuBoard.title}」设置`}
						style={{ left: boardMenu.left, top: boardMenu.top }}
						onKeyDown={(event) => {
							const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
							const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								buttons[
									(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
								]?.focus();
							} else if (event.key === "Escape") {
								event.stopPropagation();
								setBoardMenu(undefined);
							}
						}}
					>
						<button type="button" role="menuitem" onClick={() => showBoardDialog("rename", menuBoard)}>
							<Pencil size={15} />
							重命名
						</button>
						<button type="button" role="menuitem" onClick={() => void duplicateBoard(menuBoard)}>
							<Copy size={15} />
							创建副本
						</button>
						<button
							type="button"
							role="menuitem"
							className="research-canvas-danger"
							onClick={() => showBoardDialog("delete", menuBoard)}
						>
							<Trash2 size={15} />
							删除画布
						</button>
					</div>,
					document.fullscreenElement === layoutRef.current ? layoutRef.current! : document.body,
				)}
			{boardDialog &&
				createPortal(
					<div className="research-canvas-board-dialog-backdrop">
						<form
							className="research-canvas-board-dialog"
							role="dialog"
							aria-modal="true"
							aria-label={boardDialog.kind === "rename" ? "重命名画布" : "删除画布"}
							onSubmit={(event) => {
								event.preventDefault();
								if (boardDialog.kind === "rename") void renameBoard();
								else void deleteBoard(boardDialog.item);
							}}
							onKeyDown={(event) => {
								event.stopPropagation();
								if (event.key === "Escape" && !busy) setBoardDialog(undefined);
								if (event.key === "Tab") {
									const controls = Array.from(
										event.currentTarget.querySelectorAll<HTMLElement>(
											"input:not(:disabled), button:not(:disabled)",
										),
									);
									const first = controls[0];
									const last = controls.at(-1);
									if (
										!first ||
										(event.shiftKey && document.activeElement === first) ||
										(!event.shiftKey && document.activeElement === last)
									) {
										event.preventDefault();
										(event.shiftKey ? last : first)?.focus();
									}
								}
							}}
						>
							<h2>{boardDialog.kind === "rename" ? "重命名画布" : "删除画布"}</h2>
							{boardDialog.kind === "rename" ? (
								<label>
									画布名称
									<input
										ref={boardRenameInputRef}
										value={boardDialog.title}
										maxLength={120}
										required
										disabled={busy}
										onChange={(event) =>
											setBoardDialog((current) => current && { ...current, title: event.target.value })
										}
									/>
								</label>
							) : (
								<p>
									永久删除「{boardDialog.title}
									」及其全部节点、连线和画布内文本，删除后无法恢复。个人库中的论文、PDF 和笔记会保留。
								</p>
							)}
							{error && (
								<p className="research-canvas-board-dialog-error" role="alert">
									{error}
								</p>
							)}
							<div className="research-canvas-board-dialog-actions">
								<button
									ref={boardDialogCancelRef}
									type="button"
									disabled={busy}
									onClick={() => setBoardDialog(undefined)}
								>
									取消
								</button>
								<button
									type="submit"
									className={boardDialog.kind === "delete" ? "danger" : "primary"}
									disabled={busy || (boardDialog.kind === "rename" && !boardDialog.title.trim())}
								>
									{busy ? "处理中…" : boardDialog.kind === "rename" ? "保存名称" : "永久删除"}
								</button>
							</div>
						</form>
					</div>,
					document.fullscreenElement === layoutRef.current ? layoutRef.current! : document.body,
				)}
			{actionDialog &&
				createPortal(
					<div className="research-canvas-board-dialog-backdrop research-canvas-action-dialog-backdrop">
						<form
							className="research-canvas-board-dialog"
							role="dialog"
							aria-modal="true"
							aria-label={actionDialog.title}
							onSubmit={(event) => {
								event.preventDefault();
								if (actionDialog.kind === "prompt") {
									if (actionDialog.value.trim()) finishAction(actionDialog.value.trim());
								} else finishAction(true);
							}}
							onKeyDown={(event) => {
								event.stopPropagation();
								if (event.key === "Escape") {
									event.preventDefault();
									finishAction(actionDialog.kind === "confirm" ? false : null);
								}
								if (event.key === "Tab") {
									const controls = Array.from(
										event.currentTarget.querySelectorAll<HTMLElement>(
											"input:not(:disabled), button:not(:disabled)",
										),
									);
									const first = controls[0];
									const last = controls.at(-1);
									if (
										!first ||
										(event.shiftKey && document.activeElement === first) ||
										(!event.shiftKey && document.activeElement === last)
									) {
										event.preventDefault();
										(event.shiftKey ? last : first)?.focus();
									}
								}
							}}
						>
							<h2>{actionDialog.title}</h2>
							{actionDialog.kind === "prompt" ? (
								<label>
									名称
									<input
										ref={actionInputRef}
										value={actionDialog.value}
										maxLength={120}
										required
										onChange={(event) =>
											setActionDialog((current) =>
												current?.kind === "prompt" ? { ...current, value: event.target.value } : current,
											)
										}
									/>
								</label>
							) : (
								<p>{actionDialog.message}</p>
							)}
							<div className="research-canvas-board-dialog-actions">
								<button
									ref={actionCancelRef}
									type="button"
									onClick={() => finishAction(actionDialog.kind === "confirm" ? false : null)}
								>
									取消
								</button>
								<button
									type="submit"
									className={actionDialog.kind === "confirm" && actionDialog.danger ? "danger" : "primary"}
									disabled={actionDialog.kind === "prompt" && !actionDialog.value.trim()}
								>
									{actionDialog.kind === "prompt" ? "保存名称" : "确定"}
								</button>
							</div>
						</form>
					</div>,
					document.fullscreenElement === layoutRef.current ? layoutRef.current! : document.body,
				)}
			{picker && (
				<div
					className="research-canvas-picker-backdrop"
					onPointerDown={(event) => {
						if (event.target === event.currentTarget) {
							setPicker(undefined);
							pendingNodePosition.current = undefined;
							pendingLinkFrom.current = undefined;
						}
					}}
				>
					<section
						className="research-canvas-picker library-picker"
						role="dialog"
						aria-modal="true"
						aria-label={`添加${nodeNames[picker]}`}
					>
						<div className="research-canvas-picker-head">
							<h2>从个人库添加{nodeNames[picker]}</h2>
							<button
								type="button"
								onClick={() => {
									setPicker(undefined);
									pendingNodePosition.current = undefined;
									pendingLinkFrom.current = undefined;
								}}
								aria-label="关闭"
							>
								<X size={18} />
							</button>
						</div>
						<div className="research-canvas-picker-content">
							{picker === "paper" && (
								<aside className="research-canvas-picker-collections" aria-label="论文分类">
									<strong>分类</strong>
									<nav aria-label="按分类筛选论文">
										<button
											type="button"
											className={pickerCollection === "all" ? "active" : ""}
											aria-pressed={pickerCollection === "all"}
											onClick={() => setPickerCollection("all")}
										>
											<BookOpen size={15} /> 全部论文
										</button>
										<button
											type="button"
											className={pickerCollection === "__uncategorized__" ? "active" : ""}
											aria-pressed={pickerCollection === "__uncategorized__"}
											onClick={() => setPickerCollection("__uncategorized__")}
										>
											<Folder size={15} /> 未分类
										</button>
										{pickerCollectionRows.map(({ collection, depth, hasChildren }) => (
											<div
												className="research-canvas-picker-collection-row"
												key={collection.id}
												style={{ paddingLeft: depth * 13 }}
											>
												{hasChildren ? (
													<button
														type="button"
														className="research-canvas-picker-collection-toggle"
														aria-label={`${pickerExpanded.has(collection.id) ? "折叠" : "展开"}${collection.name}`}
														aria-expanded={pickerExpanded.has(collection.id)}
														onClick={() =>
															setPickerExpanded((current) => {
																const next = new Set(current);
																if (next.has(collection.id)) next.delete(collection.id);
																else next.add(collection.id);
																return next;
															})
														}
													>
														<ChevronRight
															size={14}
															className={pickerExpanded.has(collection.id) ? "expanded" : ""}
														/>
													</button>
												) : (
													<span className="research-canvas-picker-collection-spacer" />
												)}
												<button
													type="button"
													className={pickerCollection === collection.id ? "active" : ""}
													aria-pressed={pickerCollection === collection.id}
													title={collection.name}
													onClick={() => setPickerCollection(collection.id)}
												>
													<Folder size={15} /> <span>{collection.name}</span>
												</button>
											</div>
										))}
									</nav>
									{pickerCollectionsError && <p role="alert">分类加载失败：{pickerCollectionsError}</p>}
								</aside>
							)}
							{picker === "note" && (
								<aside className="research-canvas-picker-collections" aria-label="笔记文件夹">
									<strong>文件夹</strong>
									<nav aria-label="按文件夹筛选笔记">
										<button
											type="button"
											className={pickerFolder === "all" ? "active" : ""}
											aria-pressed={pickerFolder === "all"}
											onClick={() => setPickerFolder("all")}
										>
											<FileText size={15} /> 全部笔记
										</button>
										<button
											type="button"
											className={pickerFolder === "__unfiled__" ? "active" : ""}
											aria-pressed={pickerFolder === "__unfiled__"}
											onClick={() => setPickerFolder("__unfiled__")}
										>
											<Folder size={15} /> 未归档
										</button>
										{pickerNoteFolderRows.map(({ folder, depth, hasChildren }) => (
											<div
												className="research-canvas-picker-collection-row"
												key={folder.id}
												style={{ paddingLeft: depth * 13 }}
											>
												{hasChildren ? (
													<button
														type="button"
														className="research-canvas-picker-collection-toggle"
														aria-label={`${pickerFolderExpanded.has(folder.id) ? "折叠" : "展开"}${folder.name}`}
														aria-expanded={pickerFolderExpanded.has(folder.id)}
														onClick={() =>
															setPickerFolderExpanded((current) => {
																const next = new Set(current);
																if (next.has(folder.id)) next.delete(folder.id);
																else next.add(folder.id);
																return next;
															})
														}
													>
														<ChevronRight
															size={14}
															className={pickerFolderExpanded.has(folder.id) ? "expanded" : ""}
														/>
													</button>
												) : (
													<span className="research-canvas-picker-collection-spacer" />
												)}
												<button
													type="button"
													className={pickerFolder === folder.id ? "active" : ""}
													aria-pressed={pickerFolder === folder.id}
													title={folder.name}
													onClick={() => setPickerFolder(folder.id)}
												>
													<Folder size={15} /> <span>{folder.name}</span>
												</button>
											</div>
										))}
									</nav>
									{pickerFoldersError && <p role="alert">文件夹加载失败：{pickerFoldersError}</p>}
								</aside>
							)}
							<div className="research-canvas-picker-results">
								<div className="research-canvas-picker-search">
									<Search size={17} />
									<input
										value={pickerQuery}
										onChange={(event) => setPickerQuery(event.target.value)}
										placeholder={`搜索${nodeNames[picker]}…`}
									/>
								</div>
								{picker === "paper" && pickerPaperPage && !pickerPaperPage.error && (
									<small className="research-canvas-picker-count">
										{pickerPaperPage.total} 篇论文
										{pickerPaperPage.total > pickerPaperPage.papers.length
											? `，显示前 ${pickerPaperPage.papers.length} 篇`
											: ""}
									</small>
								)}
								{picker === "note" && pickerNotePage && !pickerNotePage.error && (
									<small className="research-canvas-picker-count">{pickerItems.length} 篇笔记</small>
								)}
								<div
									className="research-canvas-picker-items"
									key={picker === "paper" ? pickerPaperKey : `note:${pickerFolder}`}
								>
									{picker === "paper" && !pickerPaperPage ? <p>正在加载论文…</p> : null}
									{picker === "note" && !pickerNotePage ? <p>正在加载笔记…</p> : null}
									{picker === "paper" && pickerPaperPage?.error ? (
										<p role="alert">加载论文失败：{pickerPaperPage.error}</p>
									) : null}
									{picker === "note" && pickerNotePage?.error ? (
										<p role="alert">加载笔记失败：{pickerNotePage.error}</p>
									) : null}
									{pickerItems.map((item) => (
										<button key={item.id} type="button" onClick={() => addNode(picker, item)}>
											<strong>{item.title}</strong>
											{"authors" in item && <small>{item.authors.slice(0, 3).join("、")}</small>}
											{"folderPath" in item && item.folderPath && <small>{item.folderPath}</small>}
										</button>
									))}
									{pickerItems.length === 0 &&
										(picker === "paper"
											? pickerPaperPage && !pickerPaperPage.error
											: pickerNotePage && !pickerNotePage.error) && (
											<p>没有找到匹配的{nodeNames[picker]}。</p>
										)}
								</div>
							</div>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
