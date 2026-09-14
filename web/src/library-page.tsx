import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, apiBytes, jsonBody } from "./api";
import {
	ConsentCard,
	confirmOperation,
	EmptyState,
	formatFileSize,
	LoadingBlock,
	PaperCard,
	SkeletonList,
} from "./components";
import {
	requiresWebOperationConfirmation,
	useAutomaticOperationConfirmation,
	useConfirmationPolicy,
} from "./confirmation-policy";
import { CollectionSidebar } from "./library-collections";
import { MineruControl } from "./mineru-control";
import { type AutomatedResearchLaunchInput, ResearchLauncher } from "./research-launcher";
import type {
	BackgroundJob,
	CollectionMembershipIndex,
	ConfirmationGrant,
	LocalPdfImportBatchView,
	LocalPdfImportFilePreview,
	LocalPdfImportIssue,
	PaperCollection,
	PaperRecord,
	PreparedOperation,
	ReaderState,
	ResearchNoteNavigation,
	ResearchNoteSummary,
	ZoteroCollectionEntry,
	ZoteroExportPreparation,
	ZoteroImportPreparation,
	ZoteroImportResult,
	ZoteroLibraryItem,
	ZoteroStatus,
} from "./types";
import {
	ALL_ZOTERO_ITEMS,
	allZoteroItemKeys,
	missingMetadataZoteroItems,
	UNCATEGORIZED_ZOTERO_ITEMS,
	zoteroItemsForCollection,
} from "./zotero-selection";

function zoteroActionLabel(action: ZoteroImportPreparation["items"][number]["action"]): string {
	return { create: "新建", update: "更新", unchanged: "无需更新", conflict: "冲突", skip: "跳过" }[action];
}

function zoteroMissingFields(fields: Array<"title" | "authors"> | undefined): string | undefined {
	if (!fields?.length) return undefined;
	const labels = { title: "标题", authors: "作者" };
	return `缺失信息：${fields.map((field) => labels[field]).join("、")}`;
}

function ZoteroSelectionCheckbox({
	label,
	itemKeys,
	selected,
	onToggle,
}: {
	label: string;
	itemKeys: string[];
	selected: ReadonlySet<string>;
	onToggle: (itemKeys: string[], checked: boolean) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedCount = itemKeys.reduce((count, key) => count + Number(selected.has(key)), 0);
	const checked = itemKeys.length > 0 && selectedCount === itemKeys.length;
	const indeterminate = selectedCount > 0 && !checked;
	useEffect(() => {
		if (inputRef.current) inputRef.current.indeterminate = indeterminate;
	}, [indeterminate]);
	return (
		<input
			ref={inputRef}
			type="checkbox"
			checked={checked}
			disabled={itemKeys.length === 0}
			aria-label={`选择${label}中的全部论文`}
			onChange={() => onToggle(itemKeys, !checked)}
		/>
	);
}

export function LibraryPage({
	onOpenReader,
	onTask,
	toolbarTarget,
	onOpenResearchNote,
	onAgentSession,
}: {
	onOpenReader: (state: ReaderState) => void;
	onTask: (job: BackgroundJob) => void;
	toolbarTarget: HTMLDivElement | null;
	onOpenResearchNote: (target: ResearchNoteNavigation) => void;
	onAgentSession: (sessionId: string) => void;
}) {
	const confirmationSettings = useConfirmationPolicy();
	const [query, setQuery] = useState("");
	const [papers, setPapers] = useState<PaperRecord[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [details, setDetails] = useState<any>();
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<PreparedOperation>();
	const [annotationPending, setAnnotationPending] = useState<PreparedOperation>();
	const [annotationPayload, setAnnotationPayload] = useState<Record<string, unknown>>();
	const [exportPending, setExportPending] = useState<PreparedOperation>();
	const [exportPayload, setExportPayload] = useState<Record<string, unknown>>();
	const [removalPending, setRemovalPending] = useState<PreparedOperation>();
	const [removalPayload, setRemovalPayload] = useState<Record<string, unknown>>();
	const [removalCardCollapsed, setRemovalCardCollapsed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [namespace, setNamespace] = useState("default");
	const [namespaces, setNamespaces] = useState<string[]>(["default"]);
	const [collections, setCollections] = useState<PaperCollection[]>([]);
	const [collectionMemberships, setCollectionMemberships] = useState<CollectionMembershipIndex>();
	const [collectionMembershipsLoading, setCollectionMembershipsLoading] = useState(true);
	const [activeCollection, setActiveCollection] = useState<string>("all");
	const [annotationTags, setAnnotationTags] = useState("");
	const [annotationNote, setAnnotationNote] = useState("");
	const [screeningStatus, setScreeningStatus] = useState("unreviewed");
	const [screeningReason, setScreeningReason] = useState("");
	const [screeningFilter, setScreeningFilter] = useState("all");
	const [exportFormat, setExportFormat] = useState("markdown");
	const [exportFilename, setExportFilename] = useState("");
	const [activeLibraryTool, setActiveLibraryTool] = useState<"curation" | "export">();
	const [localUploadingPaperId, setLocalUploadingPaperId] = useState<string>();
	const [importMenuOpen, setImportMenuOpen] = useState(false);
	const [localImportBatch, setLocalImportBatch] = useState<LocalPdfImportBatchView>();
	const [localImportIssues, setLocalImportIssues] = useState<LocalPdfImportIssue[]>([]);
	const [localImportProgress, setLocalImportProgress] = useState<{
		completed: number;
		total: number;
		filename: string;
	}>();
	const [localImportBusy, setLocalImportBusy] = useState(false);
	const [zoteroImportOpen, setZoteroImportOpen] = useState(false);
	const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatus>();
	const [zoteroCollections, setZoteroCollections] = useState<ZoteroCollectionEntry[]>([]);
	const [zoteroItems, setZoteroItems] = useState<ZoteroLibraryItem[]>([]);
	const [zoteroItemKeys, setZoteroItemKeys] = useState<Set<string>>(new Set());
	const [activeZoteroCollection, setActiveZoteroCollection] = useState(ALL_ZOTERO_ITEMS);
	const [zoteroImportPrepared, setZoteroImportPrepared] = useState<ZoteroImportPreparation>();
	const [zoteroImportFinished, setZoteroImportFinished] = useState(false);
	const [zoteroImportProgress, setZoteroImportProgress] = useState<{ completed: number; total: number }>();
	const [zoteroExportPrepared, setZoteroExportPrepared] = useState<ZoteroExportPreparation>();
	const [zoteroBusy, setZoteroBusy] = useState(false);
	const [artifactFolderOpening, setArtifactFolderOpening] = useState(false);
	const [noteIndex, setNoteIndex] = useState<Record<string, ResearchNoteSummary[]>>({});
	const visibleZoteroItems = useMemo(
		() => zoteroItemsForCollection(zoteroCollections, zoteroItems, activeZoteroCollection, false),
		[zoteroCollections, zoteroItems, activeZoteroCollection],
	);
	const zoteroCollectionRows = useMemo(
		() => [
			{
				key: ALL_ZOTERO_ITEMS,
				label: "全部论文",
				depth: 0,
				itemKeys: allZoteroItemKeys(zoteroItems),
			},
			{
				key: UNCATEGORIZED_ZOTERO_ITEMS,
				label: "未分类",
				depth: 0,
				itemKeys: allZoteroItemKeys(
					zoteroItemsForCollection(zoteroCollections, zoteroItems, UNCATEGORIZED_ZOTERO_ITEMS, false),
				),
			},
			...zoteroCollections.map((collection) => ({
				key: collection.key,
				label: collection.name,
				depth: collection.path.length,
				itemKeys: allZoteroItemKeys(zoteroItemsForCollection(zoteroCollections, zoteroItems, collection.key, true)),
			})),
		],
		[zoteroCollections, zoteroItems],
	);
	const importButtonRef = useRef<HTMLButtonElement>(null);
	const importMenuRef = useRef<HTMLDivElement>(null);
	const localImportInputRef = useRef<HTMLInputElement>(null);
	const curationButtonRef = useRef<HTMLButtonElement>(null);
	const exportButtonRef = useRef<HTMLButtonElement>(null);
	const inlineToolRef = useRef<HTMLElement>(null);
	const localFileRef = useRef<HTMLInputElement>(null);
	const localPdfTargetRef = useRef<PaperRecord | undefined>(undefined);
	const localImportBatchIdRef = useRef<string | undefined>(undefined);
	const zoteroNamespaceRef = useRef(namespace);
	const zoteroImportOperationIdRef = useRef<string | undefined>(undefined);
	const zoteroExportOperationIdRef = useRef<string | undefined>(undefined);
	const cancelLocalImport = useCallback(async (returnFocus = true) => {
		const batchId = localImportBatchIdRef.current;
		setImportMenuOpen(false);
		setLocalImportBatch(undefined);
		setLocalImportIssues([]);
		setLocalImportProgress(undefined);
		localImportBatchIdRef.current = undefined;
		if (localImportInputRef.current) localImportInputRef.current.value = "";
		if (batchId) {
			try {
				await api(`/api/library/local-imports/${encodeURIComponent(batchId)}`, { method: "DELETE" });
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			}
		}
		if (returnFocus) window.setTimeout(() => importButtonRef.current?.focus(), 0);
	}, []);
	useEffect(() => {
		if (!message) return;
		const timer = window.setTimeout(() => {
			setMessage((current) => (current === message ? "" : current));
		}, 5_000);
		return () => window.clearTimeout(timer);
	}, [message]);
	useEffect(() => {
		localImportBatchIdRef.current = localImportBatch?.id;
	}, [localImportBatch?.id]);
	useEffect(() => {
		zoteroImportOperationIdRef.current = zoteroImportPrepared?.operation.operationId;
		zoteroExportOperationIdRef.current = zoteroExportPrepared?.operation.operationId;
	}, [zoteroImportPrepared?.operation.operationId, zoteroExportPrepared?.operation.operationId]);
	useEffect(
		() => () => {
			const batchId = localImportBatchIdRef.current;
			if (batchId) void fetch(`/api/library/local-imports/${encodeURIComponent(batchId)}`, { method: "DELETE" });
		},
		[],
	);
	useEffect(() => {
		if (!importMenuOpen) return;
		const closeMenu = (event: MouseEvent) => {
			if (!importMenuRef.current?.contains(event.target as Node)) setImportMenuOpen(false);
		};
		document.addEventListener("mousedown", closeMenu);
		return () => document.removeEventListener("mousedown", closeMenu);
	}, [importMenuOpen]);
	useEffect(() => {
		if (!importMenuOpen && !localImportBatch) return;
		const close = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (importMenuOpen) {
				setImportMenuOpen(false);
				importButtonRef.current?.focus();
				return;
			}
			if (!localImportBusy) void cancelLocalImport();
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [importMenuOpen, localImportBatch, localImportBusy, cancelLocalImport]);
	useEffect(() => {
		void api<{ defaultNamespace: string; personal: string[] }>("/api/namespaces")
			.then((value) => {
				setNamespace(value.defaultNamespace);
				setNamespaces(value.personal);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, []);
	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const params = new URLSearchParams({ q: query, namespace, limit: "300" });
			if (screeningFilter !== "all") params.append("screeningStatus", screeningFilter);
			if (activeCollection !== "all") params.append("collection", activeCollection);
			setPapers(
				(await api<{ hits: Array<{ record: PaperRecord }> }>(`/api/library?${params.toString()}`)).hits.map(
					(hit) => hit.record,
				),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, [namespace, query, screeningFilter, activeCollection]);
	useEffect(() => {
		setSelected(new Set());
		setDetails(undefined);
		void load();
	}, [load]);
	useEffect(() => {
		if (!selected.size) setActiveLibraryTool(undefined);
	}, [selected.size]);
	useEffect(() => {
		if (!removalPending) setRemovalCardCollapsed(false);
	}, [removalPending]);
	useEffect(() => {
		if (!activeLibraryTool || annotationPending || exportPending) return;
		const timer = window.setTimeout(() => {
			inlineToolRef.current
				?.querySelector<HTMLElement>(
					".library-curation-form input, .library-curation-form select, .library-export-form select, .library-export-form input",
				)
				?.focus();
		}, 0);
		return () => window.clearTimeout(timer);
	}, [activeLibraryTool, annotationPending, exportPending]);
	useEffect(() => {
		if (!activeLibraryTool || annotationPending || exportPending) return;
		const currentTool = activeLibraryTool;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setActiveLibraryTool(undefined);
			window.setTimeout(
				() => (currentTool === "curation" ? curationButtonRef.current : exportButtonRef.current)?.focus(),
				0,
			);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [activeLibraryTool, annotationPending, exportPending]);
	const loadCollectionData = useCallback(async () => {
		setCollectionMemberships(undefined);
		setCollectionMembershipsLoading(true);
		const [collectionsResult, membershipsResult] = await Promise.allSettled([
			api<PaperCollection[]>(`/api/library/collections?namespace=${encodeURIComponent(namespace)}`),
			api<CollectionMembershipIndex>(
				`/api/library/collection-memberships?namespace=${encodeURIComponent(namespace)}`,
			),
		]);
		if (collectionsResult.status === "fulfilled") setCollections(collectionsResult.value);
		else
			setError(
				collectionsResult.reason instanceof Error
					? collectionsResult.reason.message
					: String(collectionsResult.reason),
			);
		if (membershipsResult.status === "fulfilled") setCollectionMemberships(membershipsResult.value);
		else
			setError(
				membershipsResult.reason instanceof Error
					? membershipsResult.reason.message
					: String(membershipsResult.reason),
			);
		setCollectionMembershipsLoading(false);
	}, [namespace]);
	useEffect(() => {
		void loadCollectionData();
	}, [loadCollectionData]);
	useEffect(() => {
		let cancelled = false;
		void api<{ byPaperId: Record<string, ResearchNoteSummary[]> }>(
			`/api/research/note-index?namespace=${encodeURIComponent(namespace)}`,
		)
			.then((value) => {
				if (!cancelled) setNoteIndex(value.byPaperId);
			})
			.catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
		return () => {
			cancelled = true;
		};
	}, [namespace]);
	const open = async (paper: PaperRecord) => {
		setError("");
		try {
			setDetails(
				await api(`/api/papers/${encodeURIComponent(paper.id)}?namespace=${encodeURIComponent(namespace)}`),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const openArtifactFolder = async () => {
		if (!details?.paper?.id || artifactFolderOpening) return;
		setArtifactFolderOpening(true);
		setError("");
		try {
			await api(
				`/api/papers/${encodeURIComponent(details.paper.id)}/artifacts/open?namespace=${encodeURIComponent(namespace)}`,
				{ method: "POST" },
			);
			setMessage("已打开 Artifact 文件夹。");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setArtifactFolderOpening(false);
		}
	};
	const loadZotero = async () => {
		setImportMenuOpen(false);
		setActiveLibraryTool(undefined);
		setZoteroImportOpen(true);
		setZoteroImportPrepared(undefined);
		setZoteroImportFinished(false);
		setZoteroImportProgress(undefined);
		setZoteroCollections([]);
		setZoteroItems([]);
		setZoteroItemKeys(new Set());
		setActiveZoteroCollection(ALL_ZOTERO_ITEMS);
		setZoteroBusy(true);
		setError("");
		try {
			const status = await api<ZoteroStatus>("/api/zotero/status");
			setZoteroStatus(status);
			if (!status.localApiEnabled) return;
			const [nextCollections, nextItems] = await Promise.all([
				api<ZoteroCollectionEntry[]>("/api/zotero/collections"),
				api<ZoteroLibraryItem[]>("/api/zotero/items"),
			]);
			setZoteroCollections(nextCollections);
			setZoteroItems(nextItems);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroBusy(false);
		}
	};
	const closeZoteroImport = async () => {
		const operationId = zoteroImportPrepared?.operation.operationId;
		setZoteroImportOpen(false);
		setZoteroImportPrepared(undefined);
		setZoteroImportFinished(false);
		setZoteroImportProgress(undefined);
		setZoteroItemKeys(new Set());
		setActiveZoteroCollection(ALL_ZOTERO_ITEMS);
		if (operationId) {
			await api(`/api/zotero/imports/${encodeURIComponent(operationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
	};
	const prepareZoteroImport = async (itemKeys = [...zoteroItemKeys]) => {
		setZoteroBusy(true);
		setError("");
		try {
			if (zoteroImportFinished && zoteroImportPrepared) {
				await api(`/api/zotero/imports/${encodeURIComponent(zoteroImportPrepared.operation.operationId)}`, {
					method: "DELETE",
				}).catch(() => undefined);
			}
			setZoteroImportFinished(false);
			const prepared = await api<ZoteroImportPreparation>(
				"/api/zotero/imports/prepare",
				jsonBody({
					namespace,
					collectionKeys: [],
					itemKeys,
					includeSubcollections: false,
				}),
			);
			setZoteroImportPrepared(prepared);
			setZoteroImportFinished(prepared.acceptedCount === 0);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroBusy(false);
		}
	};
	const executeZoteroImport = async () => {
		if (!zoteroImportPrepared) return;
		const prepared = zoteroImportPrepared;
		const executableItems = prepared.items.filter((item) => item.action !== "conflict" && item.action !== "skip");
		setZoteroBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(prepared.operation)) as ConfirmationGrant;
			const failures: Record<string, string> = {};
			let importedCount = 0;
			let existingCount = 0;
			setZoteroImportProgress({ completed: 0, total: executableItems.length });
			for (const [index, item] of executableItems.entries()) {
				try {
					const result = await api<ZoteroImportResult>(
						`/api/zotero/imports/${encodeURIComponent(prepared.operation.operationId)}/items/${encodeURIComponent(item.itemKey)}`,
						jsonBody({ grant }),
					);
					if (result.failed.length) {
						failures[item.itemKey] = result.failed[0].error;
					} else {
						importedCount += result.outcomes.filter((outcome) => outcome.status !== "unchanged").length;
						existingCount += result.outcomes.filter((outcome) => outcome.status === "unchanged").length;
						setZoteroImportPrepared((current) =>
							current
								? { ...current, items: current.items.filter((entry) => entry.itemKey !== item.itemKey) }
								: current,
						);
					}
				} catch (reason) {
					failures[item.itemKey] = reason instanceof Error ? reason.message : String(reason);
				}
				setZoteroImportProgress({ completed: index + 1, total: executableItems.length });
			}
			await Promise.all([load(), loadCollectionData()]);
			const unresolvedItems = missingMetadataZoteroItems(prepared.items);
			if (unresolvedItems.length) {
				setZoteroImportPrepared({ ...prepared, items: unresolvedItems, acceptedCount: 0 });
				setZoteroImportFinished(true);
				setMessage(
					`已保存 ${importedCount} 篇，已存在 ${existingCount} 篇；${unresolvedItems.length} 篇缺失信息。`,
				);
			} else {
				await closeZoteroImport();
				setMessage(`已保存 ${importedCount} 篇，个人库已存在 ${existingCount} 篇。`);
			}
			if (Object.keys(failures).length) {
				const details = Object.values(failures).slice(0, 2).join("；");
				setError(`${Object.keys(failures).length} 篇因执行错误未保存：${details}`);
			}
		} catch (reason) {
			await closeZoteroImport();
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroImportProgress(undefined);
			setZoteroBusy(false);
		}
	};
	const refreshZoteroStatus = async () => {
		try {
			setZoteroStatus(await api<ZoteroStatus>("/api/zotero/status"));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const authorizeZotero = async () => {
		setZoteroBusy(true);
		setError("");
		try {
			setZoteroStatus(await api<ZoteroStatus>("/api/zotero/authorize", { method: "POST" }));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setZoteroBusy(false);
		}
	};
	useEffect(() => {
		if (zoteroNamespaceRef.current === namespace) return;
		zoteroNamespaceRef.current = namespace;
		const importOperationId = zoteroImportOperationIdRef.current;
		const exportOperationId = zoteroExportOperationIdRef.current;
		setZoteroImportOpen(false);
		setZoteroImportPrepared(undefined);
		setZoteroImportFinished(false);
		setZoteroImportProgress(undefined);
		setZoteroItemKeys(new Set());
		setActiveZoteroCollection(ALL_ZOTERO_ITEMS);
		setZoteroExportPrepared(undefined);
		if (exportOperationId) {
			setExportPending(undefined);
			setExportPayload(undefined);
		}
		if (importOperationId) {
			void api(`/api/zotero/imports/${encodeURIComponent(importOperationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
		if (exportOperationId) {
			void api(`/api/zotero/exports/${encodeURIComponent(exportOperationId)}`, { method: "DELETE" }).catch(
				() => undefined,
			);
		}
	}, [namespace]);
	const prepareDownload = async (paperIds: string[]) => {
		setActiveLibraryTool(undefined);
		setBusy(true);
		setError("");
		try {
			setPending(await api("/api/pdf-downloads/prepare", jsonBody({ paperIds, namespace })));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeDownload = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(pending)) as ConfirmationGrant;
			const job = await api<BackgroundJob>(
				"/api/pdf-downloads/execute",
				jsonBody({ paperIds: [...selected], namespace, grant }),
			);
			onTask(job);
			setPending(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const prepareDownloadForCurrentPaper = async () => {
		if (!details?.paper?.id) return;
		setSelected(new Set([details.paper.id]));
		await prepareDownload([details.paper.id]);
	};
	const startAutomatedResearch = async (input: AutomatedResearchLaunchInput) => {
		const response = await api<{ session: { id: string } }>("/api/agent/research/start", jsonBody(input));
		onAgentSession(response.session.id);
	};
	const prepareAnnotation = async () => {
		if (!selected.size) return;
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const payload: Record<string, unknown> = {
				paperIds: [...selected],
				namespace,
				tags: annotationTags
					.split(",")
					.map((tag) => tag.trim())
					.filter(Boolean),
				note: annotationNote,
				screeningStatus: screeningStatus === "unreviewed" ? undefined : screeningStatus,
				screeningReason,
			};
			setAnnotationPayload(payload);
			setAnnotationPending(await api("/api/library/annotations/prepare", jsonBody(payload)));
			setActiveLibraryTool(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeAnnotation = async () => {
		if (!annotationPending || !annotationPayload) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(annotationPending)) as ConfirmationGrant;
			const result = await api<{ count: number }>(
				"/api/library/annotations/execute",
				jsonBody({ ...annotationPayload, grant }),
			);
			setMessage(`已更新 ${result.count} 篇个人论文的标签、笔记或筛选状态。`);
			setAnnotationPending(undefined);
			setAnnotationPayload(undefined);
			setActiveLibraryTool(undefined);
			setSelected(new Set());
			setDetails(undefined);
			setAnnotationTags("");
			setAnnotationNote("");
			setScreeningStatus("unreviewed");
			setScreeningReason("");
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const prepareExport = async () => {
		if (!selected.size) return;
		setBusy(true);
		setError("");
		setMessage("");
		try {
			if (exportFormat === "zotero") {
				const prepared = await api<ZoteroExportPreparation>(
					"/api/zotero/exports/prepare",
					jsonBody({ paperIds: [...selected], namespace }),
				);
				setZoteroExportPrepared(prepared);
				setExportPayload({ zotero: true, operationId: prepared.operation.operationId });
				setExportPending(prepared.operation);
				setActiveLibraryTool(undefined);
				return;
			}
			const payload: Record<string, unknown> = {
				paperIds: [...selected],
				namespace,
				format: exportFormat,
				filename: exportFilename.trim() || undefined,
			};
			setExportPayload(payload);
			setExportPending(await api("/api/library/export/prepare", jsonBody(payload)));
			setActiveLibraryTool(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const executeExport = async () => {
		if (!exportPending || !exportPayload) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(exportPending)) as ConfirmationGrant;
			if (exportPayload.zotero && typeof exportPayload.operationId === "string") {
				const result = await api<{
					created: number;
					updated: number;
					unchanged: number;
					failed: Array<{ paperId: string; error: string }>;
				}>(`/api/zotero/exports/${encodeURIComponent(exportPayload.operationId)}`, jsonBody({ grant }));
				if (result.created + result.updated + result.unchanged > 0) {
					setMessage(
						`Zotero 导出完成：新建 ${result.created}，更新 ${result.updated}，未变化 ${result.unchanged}。`,
					);
				}
				if (result.failed.length > 0) {
					setError(
						`Zotero 导出失败：${result.failed.map((failure) => `${failure.paperId}：${failure.error}`).join("；")}`,
					);
				}
				setExportPending(undefined);
				setExportPayload(undefined);
				setZoteroExportPrepared(undefined);
				setActiveLibraryTool(undefined);
				return;
			}
			const result = await api<{ filename: string; count: number }>(
				"/api/library/export/execute",
				jsonBody({ ...exportPayload, grant }),
			);
			const bytes = await apiBytes(
				`/api/library/exports/${encodeURIComponent(result.filename)}?namespace=${encodeURIComponent(namespace)}`,
			);
			const objectUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = result.filename;
			anchor.click();
			URL.revokeObjectURL(objectUrl);
			setMessage(`已导出 ${result.count} 篇论文：${result.filename}`);
			setExportPending(undefined);
			setExportPayload(undefined);
			setActiveLibraryTool(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};
	const hasAnnotationChanges = Boolean(
		annotationTags.trim() || annotationNote.trim() || screeningStatus !== "unreviewed",
	);
	const closeLibraryTool = () => {
		const currentTool = activeLibraryTool;
		setActiveLibraryTool(undefined);
		window.setTimeout(
			() => (currentTool === "curation" ? curationButtonRef.current : exportButtonRef.current)?.focus(),
			0,
		);
	};
	const chooseLocalPdf = (paper: PaperRecord) => {
		if (localUploadingPaperId) return;
		setError("");
		setMessage("");
		localPdfTargetRef.current = paper;
		localFileRef.current?.click();
	};
	async function handleAddLocalPdf(file: File) {
		const target = localPdfTargetRef.current;
		if (!target) return;
		setLocalUploadingPaperId(target.id);
		setError("");
		setMessage("");
		try {
			await api(`/api/papers/${encodeURIComponent(target.id)}/pdf?namespace=${encodeURIComponent(namespace)}`, {
				method: "POST",
				headers: { "content-type": "application/pdf" },
				body: file,
			});
			setMessage(`已将本地 PDF 关联到《${target.title}》。`);
			await load();
			if (details?.paper?.id === target.id) await open(target);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "关联本地 PDF 失败");
		} finally {
			setLocalUploadingPaperId(undefined);
			localPdfTargetRef.current = undefined;
			if (localFileRef.current) localFileRef.current.value = "";
		}
	}
	async function handleLocalImportFiles(files: File[]) {
		setImportMenuOpen(false);
		setError("");
		setMessage("");
		setLocalImportIssues([]);
		if (files.length === 0) return;
		if (files.length > 20) {
			setError("一次最多导入 20 个 PDF 文件。");
			return;
		}
		const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
		if (totalBytes > 500 * 1024 * 1024) {
			setError("所选 PDF 总大小超过 500 MB。");
			return;
		}
		setLocalImportBusy(true);
		try {
			const collectionId = !["all", "__uncategorized__"].includes(activeCollection) ? activeCollection : undefined;
			const created = await api<LocalPdfImportBatchView>(
				"/api/library/local-imports",
				jsonBody({ namespace, collectionId }),
			);
			setLocalImportBatch(created);
			localImportBatchIdRef.current = created.id;
			const uploaded: LocalPdfImportFilePreview[] = [];
			const issues: LocalPdfImportIssue[] = [];
			for (const [index, file] of files.entries()) {
				setLocalImportProgress({ completed: index, total: files.length, filename: file.name });
				try {
					const preview = await api<LocalPdfImportFilePreview>(
						`/api/library/local-imports/${encodeURIComponent(created.id)}/files`,
						{
							method: "POST",
							headers: {
								"content-type": "application/pdf",
								"x-filename": encodeURIComponent(file.name),
							},
							body: file,
						},
					);
					uploaded.push(preview);
					setLocalImportBatch((current) => (current ? { ...current, files: [...uploaded] } : current));
				} catch (reason) {
					issues.push({
						filename: file.name,
						message: reason instanceof Error ? reason.message : String(reason),
					});
					setLocalImportIssues([...issues]);
				}
			}
			setLocalImportProgress({ completed: files.length, total: files.length, filename: "" });
			if (uploaded.length) {
				setLocalImportBatch(
					await api<LocalPdfImportBatchView>(
						`/api/library/local-imports/${encodeURIComponent(created.id)}/prepare`,
						{ method: "POST" },
					),
				);
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLocalImportBusy(false);
			setLocalImportProgress(undefined);
			if (localImportInputRef.current) localImportInputRef.current.value = "";
		}
	}

	async function executeLocalImport() {
		if (!localImportBatch?.operation) return;
		setLocalImportBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(localImportBatch.operation)) as ConfirmationGrant;
			const result = await api<{
				records: PaperRecord[];
				outcomes: Array<{ paperId: string; status: "created" | "updated" | "unchanged" }>;
			}>(`/api/library/local-imports/${encodeURIComponent(localImportBatch.id)}/execute`, jsonBody({ grant }));
			const created = result.outcomes.filter((outcome) => outcome.status === "created").length;
			const updated = result.outcomes.filter((outcome) => outcome.status === "updated").length;
			const unchanged = result.outcomes.filter((outcome) => outcome.status === "unchanged").length;
			setMessage(`已导入 ${result.records.length} 篇论文：新建 ${created}，更新 ${updated}，未变更 ${unchanged}。`);
			setLocalImportBatch(undefined);
			setLocalImportIssues([]);
			localImportBatchIdRef.current = undefined;
			await Promise.all([load(), loadCollectionData()]);
		} catch (reason) {
			setLocalImportBatch(undefined);
			setLocalImportIssues([]);
			localImportBatchIdRef.current = undefined;
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLocalImportBusy(false);
		}
	}
	async function addPapersToCollection(paperIds: string[], collectionId: string) {
		if (!paperIds.length) return;
		if (
			requiresWebOperationConfirmation("personal-corpus-write", confirmationSettings) &&
			!window.confirm(`将 ${paperIds.length} 篇论文添加到所选分类？`)
		)
			return;
		setBusy(true);
		setError("");
		try {
			await api(
				`/api/library/collections/${encodeURIComponent(collectionId)}/papers`,
				jsonBody({ paperIds, mode: "assign", namespace }, "PATCH"),
			);
			setMessage(paperIds.length === 1 ? "已添加到分类" : `已将 ${paperIds.length} 篇论文添加到分类`);
			await Promise.all([load(), loadCollectionData()]);
			const detailPaperId = details?.paper?.id;
			const target = detailPaperId ? papers.find((paper) => paper.id === detailPaperId) : undefined;
			if (detailPaperId && paperIds.includes(detailPaperId) && target) await open(target);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	async function addPaperToCollection(paperId: string, collectionId: string) {
		await addPapersToCollection([paperId], collectionId);
	}
	async function movePaperToCollection(paperId: string, collectionId: string | null) {
		if (
			requiresWebOperationConfirmation("personal-collection-remove", confirmationSettings) &&
			!window.confirm(collectionId ? "移动后会替换这篇论文当前的分类归属。" : "将这篇论文移出当前分类？")
		)
			return;
		setBusy(true);
		setError("");
		try {
			const next = collectionId ? [collectionId] : [];
			await api(
				`/api/papers/${encodeURIComponent(paperId)}/collections`,
				jsonBody({ collectionIds: next, namespace }, "PATCH"),
			);
			setMessage(collectionId ? "已移动到分类" : "已移出分类(未分类)");
			await Promise.all([load(), loadCollectionData()]);
			const target = papers.find((paper) => paper.id === paperId);
			if (details?.paper?.id === paperId && target) await open(target);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	async function preparePaperRemoval(target: PaperRecord | string[]) {
		if (Array.isArray(target) && !target.length) return;
		setActiveLibraryTool(undefined);
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const payload = Array.isArray(target)
				? { paperIds: target, namespace }
				: {
						paperId: target.id,
						namespace,
						...(activeCollection !== "all" && activeCollection !== "__uncategorized__"
							? { collectionId: activeCollection }
							: {}),
					};
			setRemovalPayload(payload);
			setRemovalPending(await api<PreparedOperation>("/api/library/papers/remove/prepare", jsonBody(payload)));
		} catch (reason) {
			setRemovalPayload(undefined);
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	async function executePaperRemoval() {
		if (!removalPending || !removalPayload) return;
		setBusy(true);
		setError("");
		try {
			const grant = (await confirmOperation(removalPending)) as ConfirmationGrant;
			const result = await api<{ mode: string; deleted?: string[]; removedFromCollection?: string[] }>(
				"/api/library/papers/remove/execute",
				jsonBody({ ...removalPayload, grant }),
			);
			const paperIds = Array.isArray(removalPayload.paperIds)
				? removalPayload.paperIds.filter((id): id is string => typeof id === "string")
				: typeof removalPayload.paperId === "string"
					? [removalPayload.paperId]
					: [];
			setSelected((current) => {
				const next = new Set(current);
				for (const paperId of paperIds) next.delete(paperId);
				return next;
			});
			if (paperIds.includes(details?.paper?.id)) setDetails(undefined);
			setMessage(
				result.mode === "remove-from-collection"
					? `已从当前分类中移除 ${result.removedFromCollection?.length ?? paperIds.length} 篇论文。`
					: `已删除 ${result.deleted?.length ?? paperIds.length} 篇论文及其本地 PDF、Artifact、派生数据和笔记关联。`,
			);
			setRemovalPending(undefined);
			setRemovalPayload(undefined);
			await Promise.all([load(), loadCollectionData()]);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	}
	const otherLibraryActionLocked = busy || Boolean(pending || annotationPending || exportPending || removalPending);
	const libraryActionLocked =
		otherLibraryActionLocked || localImportBusy || Boolean(localImportBatch) || zoteroBusy || zoteroImportOpen;
	const membershipPaperIds = {
		all: collectionMemberships?.allPaperIds ?? [],
		__uncategorized__: collectionMemberships?.uncategorizedPaperIds ?? [],
		...(collectionMemberships?.collectionPaperIds ?? {}),
	};
	const toggleCollectionSelection = (paperIds: string[], checked: boolean) => {
		setSelected((current) => {
			const next = new Set(current);
			for (const paperId of paperIds) checked ? next.add(paperId) : next.delete(paperId);
			return next;
		});
	};
	const toggleZoteroItemSelection = (itemKeys: string[], checked: boolean) => {
		setZoteroItemKeys((current) => {
			const next = new Set(current);
			for (const itemKey of itemKeys) checked ? next.add(itemKey) : next.delete(itemKey);
			return next;
		});
	};
	const localImportConfirmation = useAutomaticOperationConfirmation(
		localImportBatch?.operation,
		localImportBusy,
		executeLocalImport,
	);
	const zoteroImportConfirmation = useAutomaticOperationConfirmation(
		zoteroImportPrepared?.operation,
		zoteroBusy,
		executeZoteroImport,
	);
	const selectCollection = (collectionId: string) => {
		if (localImportBusy) {
			setError("请等待当前 PDF 解析完成后再切换分类。");
			return;
		}
		if (localImportBatch) void cancelLocalImport(false);
		setActiveCollection(collectionId);
	};
	const libraryToolbar = (
		<div className="library-main-sticky-head">
			<div className="library-action-toolbar">
				<div className="library-import-menu-wrap" ref={importMenuRef}>
					<button
						ref={importButtonRef}
						className={`button secondary library-import-trigger${importMenuOpen ? " active" : ""}`}
						type="button"
						disabled={
							otherLibraryActionLocked ||
							localImportBusy ||
							Boolean(localImportBatch) ||
							zoteroBusy ||
							zoteroImportOpen
						}
						aria-haspopup="menu"
						aria-expanded={importMenuOpen}
						onClick={() => setImportMenuOpen((current) => !current)}
					>
						<span aria-hidden="true">+</span> 导入
					</button>
					{importMenuOpen && (
						<div className="library-import-menu" role="menu">
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setImportMenuOpen(false);
									localImportInputRef.current?.click();
								}}
							>
								本地文件导入
							</button>
							<button type="button" role="menuitem" onClick={() => void loadZotero()}>
								从 Zotero 导入
							</button>
						</div>
					)}
				</div>
				<button
					className="button primary"
					type="button"
					disabled={!selected.size || libraryActionLocked}
					onClick={() => void prepareDownload([...selected])}
				>
					下载所选 PDF
				</button>
				<button
					ref={curationButtonRef}
					className={`button secondary library-tool-trigger${activeLibraryTool === "curation" ? " active" : ""}`}
					type="button"
					disabled={!selected.size || libraryActionLocked}
					aria-expanded={activeLibraryTool === "curation"}
					aria-controls="library-curation-tool"
					onClick={() => setActiveLibraryTool((current) => (current === "curation" ? undefined : "curation"))}
				>
					批量整理
				</button>
				<button
					ref={exportButtonRef}
					className={`button secondary library-tool-trigger${activeLibraryTool === "export" ? " active" : ""}`}
					type="button"
					disabled={!selected.size || libraryActionLocked}
					aria-expanded={activeLibraryTool === "export"}
					aria-controls="library-export-tool"
					onClick={() => setActiveLibraryTool((current) => (current === "export" ? undefined : "export"))}
				>
					导出
				</button>
				<button
					className="button danger"
					type="button"
					disabled={!selected.size || libraryActionLocked}
					onClick={() => void preparePaperRemoval([...selected])}
				>
					删除
				</button>
			</div>
		</div>
	);
	const librarySearch = (
		<div className="library-toolbar library-local-search">
			<label className="library-search-control">
				<Search size={16} className="library-search-icon" />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索标题、作者、摘要、标签或笔记"
				/>
			</label>
			<label className="library-namespace-control">
				<span>Namespace</span>
				<select
					value={namespace}
					disabled={localImportBusy}
					onChange={(event) => {
						if (localImportBatch) void cancelLocalImport(false);
						setNamespace(event.target.value);
						setActiveCollection("all");
					}}
				>
					{namespaces.map((item) => (
						<option value={item} key={item}>
							{item}
						</option>
					))}
				</select>
			</label>
			<label className="library-screening-control">
				<span>筛选状态</span>
				<select value={screeningFilter} onChange={(event) => setScreeningFilter(event.target.value)}>
					<option value="all">全部</option>
					<option value="unreviewed">未筛选</option>
					<option value="include">纳入</option>
					<option value="maybe">待定</option>
					<option value="exclude">排除</option>
				</select>
			</label>
			<span>
				{papers.length} 篇 · 已选择 {selected.size}
			</span>
		</div>
	);
	return (
		<div className="library-page-layout">
			<CollectionSidebar
				collections={collections}
				activeCollection={activeCollection}
				namespace={namespace}
				membershipPaperIds={membershipPaperIds}
				membershipLoading={collectionMembershipsLoading}
				selectedPaperIds={selected}
				onSelect={selectCollection}
				onToggleSelection={toggleCollectionSelection}
				onCreated={(collection) => {
					setCollections((current) =>
						current.some((item) => item.id === collection.id) ? current : [...current, collection],
					);
					setCollectionMemberships((current) =>
						current
							? {
									...current,
									collectionPaperIds: { ...current.collectionPaperIds, [collection.id]: [] },
								}
							: current,
					);
					setActiveCollection(collection.id);
				}}
				onDeleted={(ids) => {
					const deleted = new Set(ids);
					setCollections((current) => current.filter((item) => !deleted.has(item.id)));
					if (deleted.has(activeCollection)) setActiveCollection("all");
					void Promise.all([load(), loadCollectionData()]);
				}}
				onUpdated={(collection) =>
					setCollections((current) => current.map((item) => (item.id === collection.id ? collection : item)))
				}
				onAssignPapers={addPapersToCollection}
				onError={setError}
			/>
			<div className="library-page-main">
				{toolbarTarget ? createPortal(libraryToolbar, toolbarTarget) : libraryToolbar}
				{librarySearch}
				<input
					ref={localImportInputRef}
					type="file"
					accept="application/pdf,.pdf"
					multiple
					hidden
					onChange={(event) => void handleLocalImportFiles([...(event.target.files ?? [])])}
				/>
				<input
					ref={localFileRef}
					type="file"
					accept="application/pdf,.pdf"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void handleAddLocalPdf(file);
					}}
				/>
				{error && <div className="error-banner">{error}</div>}
				{message && <div className="success-banner">{message}</div>}
				{localImportBatch && (
					<section
						className="panel library-inline-tool library-import-panel"
						aria-labelledby="library-import-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="library-import-title">导入本地 PDF</h2>
								<span>
									{localImportBatch.collection
										? `目标分类：${localImportBatch.collection.name}`
										: `目标空间：${localImportBatch.namespace} · 未分类`}
								</span>
							</div>
							<button
								className="text-button"
								type="button"
								disabled={localImportBusy}
								onClick={() => void cancelLocalImport()}
							>
								关闭
							</button>
						</div>
						{localImportProgress && (
							<output className="library-import-progress">
								<div>
									<span>
										{localImportProgress.filename
											? `正在解析 ${localImportProgress.filename}`
											: "正在准备导入预览"}
									</span>
									<strong>
										{localImportProgress.completed}/{localImportProgress.total}
									</strong>
								</div>
								<div className="progress-track small">
									<span
										style={{
											width: `${Math.max(4, (localImportProgress.completed / localImportProgress.total) * 100)}%`,
										}}
									/>
								</div>
							</output>
						)}
						<ul className="library-import-list" aria-label="本地 PDF 导入预览">
							{localImportBatch.files.map((file) => (
								<li className={`library-import-row ${file.status}`} key={file.id}>
									<div className="library-import-row-main">
										<div className="library-import-row-title">
											<strong>{file.record?.title ?? file.filename}</strong>
											<span className={`library-import-state ${file.status}`}>
												{file.status === "needs_metadata"
													? "需要元数据"
													: file.action === "created"
														? "新建"
														: file.action === "updated"
															? "更新"
															: file.action === "unchanged"
																? "已存在"
																: "已解析"}
											</span>
										</div>
										{file.record ? (
											<p>{file.record.authors.join("、")}</p>
										) : (
											<p>缺少：{file.needsMetadata?.missingFields.join("、") ?? "标题或作者"}</p>
										)}
										<small>
											{file.filename} · {formatFileSize(file.bytes)}
											{file.metadataSource ? ` · ${file.metadataSource}` : ""}
										</small>
									</div>
									{file.warnings.filter((warning) => warning.stage === "provider").length > 0 && (
										<span className="library-import-warning">Provider 未完整补全</span>
									)}
								</li>
							))}
							{localImportIssues.map((issue) => (
								<li className="library-import-row rejected" key={`${issue.filename}-${issue.message}`}>
									<div className="library-import-row-main">
										<div className="library-import-row-title">
											<strong>{issue.filename}</strong>
											<span className="library-import-state rejected">无法导入</span>
										</div>
										<p>{issue.message}</p>
									</div>
								</li>
							))}
							{localImportBatch.files.length === 0 && localImportIssues.length === 0 && (
								<p className="library-import-empty">正在读取所选 PDF…</p>
							)}
						</ul>
						<div className="library-import-summary">
							<span>
								可导入 {localImportBatch.acceptedCount} 篇
								{localImportBatch.needsMetadataCount
									? ` · ${localImportBatch.needsMetadataCount} 篇缺少元数据`
									: ""}
								{localImportBatch.possibleDuplicates.length
									? ` · ${localImportBatch.possibleDuplicates.length} 个疑似重复项`
									: ""}
							</span>
							<div className="button-row">
								<button
									className="button secondary"
									type="button"
									disabled={localImportBusy}
									onClick={() => void cancelLocalImport()}
								>
									取消
								</button>
								{(localImportConfirmation.confirmationRequired ||
									localImportConfirmation.automaticAttemptFailed) && (
									<button
										className="button primary"
										type="button"
										disabled={
											localImportBusy || !localImportBatch.operation || localImportBatch.acceptedCount === 0
										}
										onClick={() => void executeLocalImport()}
									>
										{localImportBusy ? "正在处理…" : "确认并导入"}
									</button>
								)}
							</div>
						</div>
					</section>
				)}
				{zoteroImportOpen && (
					<section
						className="panel library-inline-tool zotero-transfer-panel"
						aria-labelledby="zotero-import-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="zotero-import-title">从 Zotero 导入</h2>
								<span>{zoteroStatus?.message ?? "正在检查 Zotero…"}</span>
							</div>
							<button
								className="text-button"
								type="button"
								disabled={zoteroBusy}
								onClick={() => void closeZoteroImport()}
							>
								关闭
							</button>
						</div>
						{zoteroBusy && !zoteroImportPrepared ? (
							<LoadingBlock text="正在读取 Zotero 文库…" />
						) : !zoteroStatus?.localApiEnabled ? (
							<div className="zotero-connection-empty">
								<p>请在 Zotero 的“设置 → 高级”中启用“允许其他应用与 Zotero 通信”。</p>
								<button className="button secondary" type="button" onClick={() => void loadZotero()}>
									重新检测
								</button>
							</div>
						) : zoteroImportPrepared ? (
							<>
								<ul className="library-import-list" aria-label="Zotero 导入预览">
									{zoteroImportPrepared.items.map((item) => {
										const missingReason = zoteroMissingFields(item.missingFields);
										return (
											<li
												className={`library-import-row ${missingReason ? "failed" : item.action}`}
												key={item.itemKey}
											>
												<div className="library-import-row-main">
													<div className="library-import-row-title">
														<strong>{item.record?.title ?? item.itemKey}</strong>
														<span className={`library-import-state${missingReason ? " rejected" : ""}`}>
															{missingReason ? "无法导入" : zoteroActionLabel(item.action)}
														</span>
													</div>
													<p>
														{item.collectionPaths.map((path) => path.join(" / ")).join("；") || "未分类"}
													</p>
													<small>
														{[
															missingReason,
															item.pdf ? `PDF：${item.pdf.filename}` : undefined,
															item.conflict,
															...item.warnings,
														]
															.filter(Boolean)
															.join("；") || "仅导入元数据"}
													</small>
												</div>
											</li>
										);
									})}
								</ul>
								<div className="library-import-summary">
									<span>
										{zoteroImportProgress
											? `正在导入 ${zoteroImportProgress.completed}/${zoteroImportProgress.total}，成功后会从清单移除`
											: zoteroImportFinished
												? `还有 ${zoteroImportPrepared.items.length} 篇未导入`
												: `可导入 ${zoteroImportPrepared.acceptedCount} 篇，分类会保留完整祖先路径`}
									</span>
									<div className="button-row">
										<button
											className="button secondary"
											type="button"
											disabled={zoteroBusy}
											onClick={() => void closeZoteroImport()}
										>
											{zoteroImportFinished ? "关闭" : "取消"}
										</button>
										{!zoteroImportFinished &&
											(zoteroImportConfirmation.confirmationRequired ||
												zoteroImportConfirmation.automaticAttemptFailed) && (
												<button
													className="button primary"
													type="button"
													disabled={zoteroBusy}
													onClick={() => void executeZoteroImport()}
												>
													{zoteroBusy ? "正在导入…" : "确认并导入"}
												</button>
											)}
									</div>
								</div>
							</>
						) : (
							<>
								<div className="zotero-picker-grid">
									<div>
										<h3>分类</h3>
										<div className="zotero-picker-list zotero-collection-picker">
											{zoteroCollectionRows.map((row) => (
												<div
													className={`zotero-collection-row${activeZoteroCollection === row.key ? " is-active" : ""}`}
													key={row.key}
												>
													<ZoteroSelectionCheckbox
														label={row.label}
														itemKeys={row.itemKeys}
														selected={zoteroItemKeys}
														onToggle={toggleZoteroItemSelection}
													/>
													<button
														type="button"
														className="zotero-collection-name"
														style={{ paddingLeft: `${8 + Math.max(0, row.depth - 1) * 16}px` }}
														onClick={() => setActiveZoteroCollection(row.key)}
													>
														<span>{row.label}</span>
														<small>{row.itemKeys.length}</small>
													</button>
												</div>
											))}
										</div>
									</div>
									<div>
										<h3>论文</h3>
										<div className="zotero-picker-list">
											{visibleZoteroItems.map((item) => (
												<label className={!item.valid ? "is-disabled" : ""} key={item.key}>
													<input
														type="checkbox"
														disabled={!item.valid}
														checked={zoteroItemKeys.has(item.key)}
														onChange={(event) =>
															setZoteroItemKeys((current) => {
																const next = new Set(current);
																event.target.checked ? next.add(item.key) : next.delete(item.key);
																return next;
															})
														}
													/>
													<span>
														<strong>{item.title}</strong>
														<small>{item.authors.join("，") || "缺少作者"}</small>
													</span>
												</label>
											))}
											{visibleZoteroItems.length === 0 && (
												<p className="zotero-picker-empty">该分类暂无论文</p>
											)}
										</div>
									</div>
								</div>
								<div className="library-action-footer">
									<span>已选 {zoteroItemKeys.size} 篇论文</span>
									<button
										className="button primary"
										type="button"
										disabled={zoteroBusy || !zoteroItemKeys.size}
										onClick={() => void prepareZoteroImport()}
									>
										预览导入
									</button>
								</div>
							</>
						)}
					</section>
				)}
				{annotationPending ? (
					<ConsentCard
						operation={annotationPending}
						busy={busy}
						onCancel={() => {
							setAnnotationPending(undefined);
							setAnnotationPayload(undefined);
							setActiveLibraryTool("curation");
						}}
						onConfirm={executeAnnotation}
					/>
				) : exportPending ? (
					<>
						{zoteroExportPrepared && (
							<ul className="library-import-list" aria-label="Zotero 导出预览">
								{zoteroExportPrepared.items.map((item) => (
									<li className={`library-import-row ${item.action}`} key={item.paperId}>
										<div className="library-import-row-main">
											<div className="library-import-row-title">
												<strong>{item.title}</strong>
												<span className="library-import-state">{zoteroActionLabel(item.action)}</span>
											</div>
											<p>
												{item.collectionPaths.map((path) => path.join(" / ")).join("；") || "Zotero 根目录"}
											</p>
											<small>
												{[
													item.pdf ? `PDF：${item.pdf.filename}` : undefined,
													item.conflict,
													...item.warnings,
												]
													.filter(Boolean)
													.join("；") || "仅同步元数据"}
											</small>
										</div>
									</li>
								))}
							</ul>
						)}
						<ConsentCard
							operation={exportPending}
							busy={busy}
							onCancel={() => {
								if (zoteroExportPrepared) {
									void api(
										`/api/zotero/exports/${encodeURIComponent(zoteroExportPrepared.operation.operationId)}`,
										{ method: "DELETE" },
									).catch(() => undefined);
								}
								setExportPending(undefined);
								setExportPayload(undefined);
								setZoteroExportPrepared(undefined);
								setActiveLibraryTool("export");
							}}
							onConfirm={executeExport}
						/>
					</>
				) : activeLibraryTool === "curation" ? (
					<section
						id="library-curation-tool"
						ref={inlineToolRef}
						className="panel library-inline-tool"
						aria-labelledby="library-curation-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="library-curation-title">批量整理</h2>
								<span>{selected.size} 篇已选</span>
							</div>
							<button className="text-button" type="button" onClick={closeLibraryTool}>
								关闭
							</button>
						</div>
						<fieldset className="library-curation-form" disabled={busy}>
							<label>
								<span>标签</span>
								<input
									value={annotationTags}
									onChange={(event) => setAnnotationTags(event.target.value)}
									placeholder="多个标签用逗号分隔"
								/>
							</label>
							<label>
								<span>筛选状态</span>
								<select
									value={screeningStatus}
									onChange={(event) => {
										setScreeningStatus(event.target.value);
										if (event.target.value === "unreviewed") setScreeningReason("");
									}}
								>
									<option value="unreviewed">保持原状态</option>
									<option value="include">纳入</option>
									<option value="maybe">待定</option>
									<option value="exclude">排除</option>
								</select>
							</label>
							<label className="wide">
								<span>筛选理由</span>
								<input
									value={screeningReason}
									onChange={(event) => setScreeningReason(event.target.value)}
									disabled={screeningStatus === "unreviewed"}
									placeholder={screeningStatus === "unreviewed" ? "选择筛选状态后填写" : "可选"}
								/>
							</label>
							<label className="wide">
								<span>个人笔记</span>
								<textarea
									value={annotationNote}
									onChange={(event) => setAnnotationNote(event.target.value)}
									placeholder="仅保存在个人库"
									rows={3}
								/>
							</label>
						</fieldset>
						<div className="library-action-footer">
							<span>{hasAnnotationChanges ? "有待保存的整理内容" : "尚未填写整理内容"}</span>
							<button
								className="button primary"
								type="button"
								disabled={!selected.size || busy || !hasAnnotationChanges}
								onClick={() => void prepareAnnotation()}
							>
								预览整理
							</button>
						</div>
					</section>
				) : activeLibraryTool === "export" ? (
					<section
						id="library-export-tool"
						ref={inlineToolRef}
						className="panel library-inline-tool library-export-panel"
						aria-labelledby="library-export-title"
					>
						<div className="library-action-heading">
							<div>
								<h2 id="library-export-title">导出所选论文</h2>
								<span>{selected.size} 篇已选</span>
							</div>
							<button className="text-button" type="button" onClick={closeLibraryTool}>
								关闭
							</button>
						</div>
						<div className="library-export-form">
							<label>
								<span>文件格式</span>
								<select
									value={exportFormat}
									onChange={(event) => {
										setExportFormat(event.target.value);
										if (event.target.value === "zotero") void refreshZoteroStatus();
									}}
								>
									<option value="markdown">Markdown 清单</option>
									<option value="csv">CSV 表格</option>
									<option value="bibtex">BibTeX 引用</option>
									<option value="json">JSON 完整元数据</option>
									<option value="zotero">Zotero</option>
								</select>
							</label>
							{exportFormat !== "zotero" && (
								<label>
									<span>文件名</span>
									<input
										value={exportFilename}
										onChange={(event) => setExportFilename(event.target.value)}
										placeholder="使用默认文件名"
									/>
								</label>
							)}
						</div>
						{exportFormat === "zotero" && (
							<div className="zotero-export-status">
								<div>
									<strong>{zoteroStatus?.message ?? "尚未检测 Zotero"}</strong>
									<span>将复制 {selected.size} 篇论文的元数据、完整分类路径、标签和首选 PDF。</span>
								</div>
								{zoteroStatus?.localApiEnabled && !zoteroStatus.writeAuthorized ? (
									<button
										className="button secondary"
										type="button"
										disabled={zoteroBusy}
										onClick={() => void authorizeZotero()}
									>
										授权写入
									</button>
								) : (
									<button
										className="text-button"
										type="button"
										disabled={zoteroBusy}
										onClick={() => void refreshZoteroStatus()}
									>
										重新检测
									</button>
								)}
							</div>
						)}
						<button
							className="button secondary library-export-button"
							type="button"
							disabled={
								busy ||
								zoteroBusy ||
								!selected.size ||
								(exportFormat === "zotero" && !zoteroStatus?.writeAuthorized)
							}
							onClick={() => void prepareExport()}
						>
							预览导出
						</button>
					</section>
				) : null}
				{pending && (
					<ConsentCard
						operation={pending}
						busy={busy}
						onCancel={() => setPending(undefined)}
						onConfirm={executeDownload}
					/>
				)}
				{removalPending && (
					<div className={`library-removal-consent${removalCardCollapsed ? " is-collapsed" : ""}`}>
						<ConsentCard
							operation={removalPending}
							busy={busy}
							onCancel={() => {
								setRemovalPending(undefined);
								setRemovalPayload(undefined);
							}}
							onConfirm={executePaperRemoval}
						/>
					</div>
				)}
				<div className="library-layout">
					<div
						className="library-paper-pane"
						onScroll={(event) => {
							if (!removalPending) return;
							const collapsed = event.currentTarget.scrollTop > 8;
							setRemovalCardCollapsed((current) => (current === collapsed ? current : collapsed));
						}}
					>
						{loading ? (
							<SkeletonList count={4} />
						) : papers.length ? (
							<div className="paper-list">
								{papers.map((paper) => (
									<div key={paper.id} className="library-record">
										<PaperCard
											key={paper.id}
											paper={paper}
											selected={selected.has(paper.id)}
											onSelect={(checked) =>
												setSelected((current) => {
													const next = new Set(current);
													checked ? next.add(paper.id) : next.delete(paper.id);
													return next;
												})
											}
											onOpen={() => void open(paper)}
											collections={collections}
											onAddToCollection={(paperId, collectionId) =>
												void addPaperToCollection(paperId, collectionId)
											}
											onMoveToCollection={(paperId, collectionId) =>
												void movePaperToCollection(paperId, collectionId)
											}
											onLoadLocalPdf={chooseLocalPdf}
											localPdfUploading={localUploadingPaperId === paper.id}
											localPdfBusy={Boolean(localUploadingPaperId)}
											onDelete={(selectedPaper) => void preparePaperRemoval(selectedPaper)}
											deleteLabel="删除"
											deleteBusy={libraryActionLocked}
											researchNotes={noteIndex[paper.id] ?? []}
											onOpenResearchNote={(noteId) => onOpenResearchNote({ namespace, noteId })}
											onCreateResearchNote={() => onOpenResearchNote({ namespace, paperId: paper.id })}
											dragPaperIds={
												libraryActionLocked
													? undefined
													: selected.has(paper.id)
														? [...selected]
														: [paper.id]
											}
										/>
									</div>
								))}
							</div>
						) : (
							<EmptyState
								title="个人文献库暂无收录论文"
								text="您可以通过文献检索收集、批量导入本地 PDF，或由 Agent 协作检索沉淀到当前文献库。"
								tips={[
									"前往「检索与收集」页面按关键词、DOI 或 arXiv ID 搜索收录",
									"点击上方「导入」按钮，批量解析本地 PDF 论文或导入 Zotero 库",
									"在「Agent 对话」中向智能研究员描述您的科研选题与综述目标",
								]}
							/>
						)}
					</div>
					<aside className="detail-panel">
						{details ? (
							<>
								<span className="eyebrow">PAPER DETAILS · 论文详情</span>
								<h2>{details.paper.title}</h2>
								<p>{details.paper.authors.join(", ")}</p>
								<div className="detail-stats">
									<div>
										<span>PDF 版本</span>
										<strong>{details.versions.length}</strong>
									</div>
									<div>
										<span>派生记忆</span>
										<strong>{details.derived.length}</strong>
									</div>
									{details.artifact?.available && (
										<button
											type="button"
											title="在文件管理器中打开 Artifact 文件夹"
											disabled={artifactFolderOpening}
											onClick={() => void openArtifactFolder()}
										>
											<span>Artifact</span>
											<strong>{details.artifact.count}</strong>
											<small>{artifactFolderOpening ? "正在打开" : "打开文件夹"}</small>
										</button>
									)}
									<MineruControl
										source={details.versions.length ? { paperId: details.paper.id, namespace } : undefined}
										compact
									/>
								</div>
								<ResearchLauncher
									paperId={details.paper.id}
									paperTitle={details.paper.title}
									versions={details.versions ?? []}
									namespace={namespace}
									busy={busy}
									onPreparePdf={prepareDownloadForCurrentPaper}
									onStart={startAutomatedResearch}
								/>
								<h3>PDF 版本</h3>
								{details.versions.length ? (
									details.versions.map((version: any) => (
										<button
											className="version-row"
											type="button"
											key={version.sha256}
											onClick={() =>
												onOpenReader({
													title: details.paper.title,
													url: `/api/papers/${encodeURIComponent(details.paper.id)}/pdf/${version.sha256}?namespace=${encodeURIComponent(namespace)}`,
													pdfPath: version.blobPath,
													paperId: details.paper.id,
													namespace,
													sha256: version.sha256,
													bytes: version.bytes,
													retrievedAt: version.retrievedAt,
													versionKind: version.versionKind,
													versionLabel: version.versionLabel,
												})
											}
										>
											<span>{new Date(version.retrievedAt).toLocaleDateString()}</span>
											<code>{version.sha256.slice(0, 12)}</code>
											<small>{Math.round(version.bytes / 1024)} KB</small>
										</button>
									))
								) : (
									<p className="muted">尚未下载 PDF。</p>
								)}
								<h3>标签与状态</h3>
								<div className="chip-row">
									{(details.paper.curation?.tags ?? []).map((tag: string) => (
										<span className="chip active" key={tag}>
											{tag}
										</span>
									))}
									{!details.paper.curation?.tags?.length && <span className="muted">暂无标签</span>}
								</div>
								{details.paper.curation?.screening && (
									<p className="muted">
										筛选：{details.paper.curation.screening.status}
										{details.paper.curation.screening.reason
											? ` · ${details.paper.curation.screening.reason}`
											: ""}
									</p>
								)}
								{details.paper.curation?.userNotes?.length ? (
									<div>
										<h3>个人笔记</h3>
										{details.paper.curation.userNotes.slice(-5).map((note: any) => (
											<blockquote key={note.id}>{note.text}</blockquote>
										))}
									</div>
								) : null}
							</>
						) : (
							<EmptyState title="选择一篇论文" text="查看 PDF 版本、派生记忆、标签和来源。" />
						)}
					</aside>
				</div>
			</div>
		</div>
	);
}
export default LibraryPage;
