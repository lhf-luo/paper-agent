import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, jsonBody } from "./api";
import { requiresWebOperationConfirmation, useConfirmationPolicy } from "./confirmation-policy";
import {
	buildCollectionTree,
	COLLECTION_DRAG_TYPE,
	collectionDescendantIds,
	flattenCollectionTree,
	PAPER_DRAG_TYPE,
	type CollectionTreeNode,
} from "./collection-tree";
import type { PaperCollection } from "./types";

function CollectionSelectionCheckbox({
	label,
	paperIds,
	selected,
	disabled,
	onToggle,
}: {
	label: string;
	paperIds: string[];
	selected: ReadonlySet<string>;
	disabled: boolean;
	onToggle: (paperIds: string[], checked: boolean) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedCount = paperIds.reduce((count, paperId) => count + Number(selected.has(paperId)), 0);
	const checked = paperIds.length > 0 && selectedCount === paperIds.length;
	const indeterminate = selectedCount > 0 && !checked;
	useEffect(() => {
		if (inputRef.current) inputRef.current.indeterminate = indeterminate;
	}, [indeterminate]);
	return (
		<input
			ref={inputRef}
			className="collection-select-checkbox"
			type="checkbox"
			checked={checked}
			disabled={disabled || paperIds.length === 0}
			aria-label={`选择${label}中的全部论文`}
			title={paperIds.length ? `${label}：${paperIds.length} 篇论文` : `${label}中暂无论文`}
			onChange={() => onToggle(paperIds, !checked)}
		/>
	);
}

type MenuMode = "actions" | "move";

export function CollectionSidebar({
	collections,
	activeCollection,
	namespace,
	membershipPaperIds,
	membershipLoading,
	selectedPaperIds,
	onSelect,
	onToggleSelection,
	onCreated,
	onDeleted,
	onUpdated,
	onAssignPapers,
	onError,
}: {
	collections: PaperCollection[];
	activeCollection: string;
	namespace: string;
	membershipPaperIds: Record<string, string[]>;
	membershipLoading: boolean;
	selectedPaperIds: ReadonlySet<string>;
	onSelect: (id: string) => void;
	onToggleSelection: (paperIds: string[], checked: boolean) => void;
	onCreated: (collection: PaperCollection) => void;
	onDeleted: (ids: string[]) => void;
	onUpdated: (collection: PaperCollection) => void;
	onAssignPapers: (paperIds: string[], collectionId: string) => Promise<void>;
	onError: (message: string) => void;
}) {
	const [newName, setNewName] = useState("");
	const [editingId, setEditingId] = useState<string>();
	const [editName, setEditName] = useState("");
	const [childParentId, setChildParentId] = useState<string>();
	const [childName, setChildName] = useState("");
	const [menu, setMenu] = useState<{ id: string; mode: MenuMode }>();
	const [busy, setBusy] = useState(false);
	const confirmationSettings = useConfirmationPolicy();
	const [dropTargetId, setDropTargetId] = useState<string | null>();
	const [draggingCollectionId, setDraggingCollectionId] = useState<string>();
	const [expansion, setExpansion] = useState<{ namespace: string; ids: Set<string>; saved: boolean }>({
		namespace: "",
		ids: new Set(),
		saved: false,
	});
	const editInputRef = useRef<HTMLInputElement>(null);
	const childInputRef = useRef<HTMLInputElement>(null);
	const sidebarRef = useRef<HTMLElement>(null);
	const menuCloseTimerRef = useRef<number | undefined>(undefined);
	const tree = useMemo(() => buildCollectionTree(collections), [collections]);
	const flatTree = useMemo(() => flattenCollectionTree(tree), [tree]);

	useEffect(() => {
		if (expansion.namespace === namespace) {
			const knownIds = new Set(collections.map((collection) => collection.id));
			setExpansion((current) => ({
				...current,
				ids: new Set([...current.ids].filter((id) => knownIds.has(id))),
			}));
			return;
		}
		const key = `paper-agent:collection-expansion:${namespace}`;
		const raw = window.localStorage.getItem(key);
		let ids = new Set<string>();
		let saved = false;
		if (raw) {
			try {
				ids = new Set(JSON.parse(raw) as string[]);
				saved = true;
			} catch {
				window.localStorage.removeItem(key);
			}
		}
		setExpansion({ namespace, ids, saved });
	}, [collections, expansion.namespace, namespace]);

	useEffect(() => {
		if (expansion.namespace !== namespace || expansion.saved) return;
		const parentIds = new Set(
			collections
				.filter((collection) => flatTree.some((node) => node.collection.parentId === collection.id))
				.map((collection) => collection.id),
		);
		setExpansion((current) => ({ ...current, ids: parentIds }));
	}, [collections, expansion.namespace, expansion.saved, flatTree, namespace]);

	useEffect(() => {
		if (editingId) editInputRef.current?.focus();
	}, [editingId]);
	useEffect(() => {
		if (childParentId) childInputRef.current?.focus();
	}, [childParentId]);
	useEffect(() => {
		const closeMenu = (event: PointerEvent) => {
			if (!sidebarRef.current?.contains(event.target as Node)) setMenu(undefined);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setMenu(undefined);
			setEditingId(undefined);
			setChildParentId(undefined);
		};
		const clearDragState = () => {
			setDraggingCollectionId(undefined);
			setDropTargetId(undefined);
		};
		document.addEventListener("pointerdown", closeMenu);
		document.addEventListener("keydown", closeOnEscape);
		document.addEventListener("dragend", clearDragState);
		return () => {
			document.removeEventListener("pointerdown", closeMenu);
			document.removeEventListener("keydown", closeOnEscape);
			document.removeEventListener("dragend", clearDragState);
		};
	}, []);
	useEffect(
		() => () => {
			if (menuCloseTimerRef.current) window.clearTimeout(menuCloseTimerRef.current);
		},
		[],
	);
	const cancelMenuClose = () => {
		if (!menuCloseTimerRef.current) return;
		window.clearTimeout(menuCloseTimerRef.current);
		menuCloseTimerRef.current = undefined;
	};
	const scheduleMenuClose = () => {
		cancelMenuClose();
		menuCloseTimerRef.current = window.setTimeout(() => {
			setMenu(undefined);
			menuCloseTimerRef.current = undefined;
		}, 160);
	};

	function updateExpanded(update: (current: Set<string>) => Set<string>) {
		setExpansion((current) => {
			const ids = update(new Set(current.ids));
			window.localStorage.setItem(`paper-agent:collection-expansion:${namespace}`, JSON.stringify([...ids]));
			return { namespace, ids, saved: true };
		});
	}

	function reportError(reason: unknown) {
		onError(reason instanceof Error ? reason.message : String(reason));
	}

	function confirmOrdinaryChange(message: string): boolean {
		return (
			!requiresWebOperationConfirmation("personal-corpus-write", confirmationSettings) ||
			window.confirm(message)
		);
	}

	async function createCollection(name: string, parentId?: string) {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		if (!confirmOrdinaryChange(parentId ? `创建子分类“${trimmed}”？` : `创建分类“${trimmed}”？`)) return;
		setBusy(true);
		try {
			const collection = await api<PaperCollection>(
				"/api/library/collections",
				jsonBody({ name: trimmed, parentId, namespace }),
			);
			onCreated(collection);
			if (parentId) updateExpanded((ids) => ids.add(parentId));
			setNewName("");
			setChildName("");
			setChildParentId(undefined);
		} catch (reason) {
			reportError(reason);
		} finally {
			setBusy(false);
		}
	}

	async function updateCollection(id: string, updates: { name?: string; parentId?: string | null }) {
		if (busy) return;
		const action = updates.name ? `将分类重命名为“${updates.name}”？` : "移动这个分类？";
		if (!confirmOrdinaryChange(action)) return;
		setBusy(true);
		try {
			const updated = await api<PaperCollection>(
				`/api/library/collections/${encodeURIComponent(id)}?namespace=${encodeURIComponent(namespace)}`,
				jsonBody(updates, "PATCH"),
			);
			onUpdated(updated);
			if (updated.parentId) updateExpanded((ids) => ids.add(updated.parentId!));
			setEditingId(undefined);
			setMenu(undefined);
		} catch (reason) {
			reportError(reason);
		} finally {
			setBusy(false);
		}
	}

	async function deleteCollection(node: CollectionTreeNode) {
		if (busy) return;
		const childCount = collectionDescendantIds(tree, node.collection.id).length;
		const message = childCount
			? `该分类包含 ${childCount} 个子分类。论文不会被删除，只会移出这些分类。`
			: "论文不会被删除，只是移出该分类。";
		if (
			requiresWebOperationConfirmation("personal-collection-remove", confirmationSettings) &&
			!window.confirm(message)
		)
			return;
		setBusy(true);
		try {
			const result = await api<{ deletedCollectionIds: string[] }>(
				`/api/library/collections/${encodeURIComponent(node.collection.id)}?namespace=${encodeURIComponent(namespace)}`,
				{ method: "DELETE" },
			);
			onDeleted(result.deletedCollectionIds);
			setMenu(undefined);
		} catch (reason) {
			reportError(reason);
		} finally {
			setBusy(false);
		}
	}

	function acceptsDrag(event: DragEvent<HTMLElement>) {
		return (
			event.dataTransfer.types.includes(COLLECTION_DRAG_TYPE) ||
			event.dataTransfer.types.includes(PAPER_DRAG_TYPE)
		);
	}

	async function handleDrop(event: DragEvent<HTMLElement>, parentId: string | null) {
		event.preventDefault();
		event.stopPropagation();
		setDropTargetId(undefined);
		const collectionId = event.dataTransfer.getData(COLLECTION_DRAG_TYPE);
		if (collectionId) {
			if (collectionId !== parentId) await updateCollection(collectionId, { parentId });
			setDraggingCollectionId(undefined);
			return;
		}
		if (!parentId) return;
		try {
			const paperIds = JSON.parse(event.dataTransfer.getData(PAPER_DRAG_TYPE) || "[]") as unknown;
			if (Array.isArray(paperIds) && paperIds.every((id) => typeof id === "string") && paperIds.length) {
				await onAssignPapers(paperIds, parentId);
			}
		} catch (reason) {
			reportError(reason);
		}
	}

	function renderNode(node: CollectionTreeNode): ReactNode {
		const id = node.collection.id;
		const hasChildren = node.children.length > 0;
		const isExpanded = expansion.ids.has(id);
		const excludedDestinations = new Set([id, ...collectionDescendantIds(tree, id)]);
		const moveDestinations = flatTree.filter((candidate) => !excludedDestinations.has(candidate.collection.id));
		return (
			<li className="collection-branch" key={id}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: Native drag has equivalent menu controls. */}
				<div
					className={`collection-node${activeCollection === id ? " active" : ""}${dropTargetId === id ? " drop-target" : ""}`}
					draggable={!busy}
					onDragStart={(event) => {
						event.stopPropagation();
						event.dataTransfer.setData(COLLECTION_DRAG_TYPE, id);
						event.dataTransfer.effectAllowed = "move";
						setDraggingCollectionId(id);
					}}
					onDragEnd={() => {
						setDraggingCollectionId(undefined);
						setDropTargetId(undefined);
					}}
					onDragOver={(event) => {
						if (!acceptsDrag(event)) return;
						if (
							draggingCollectionId &&
							(draggingCollectionId === id || collectionDescendantIds(tree, draggingCollectionId).includes(id))
						) {
							return;
						}
						event.stopPropagation();
						event.preventDefault();
						event.dataTransfer.dropEffect = draggingCollectionId ? "move" : "copy";
						setDropTargetId(id);
					}}
					onDrop={(event) => void handleDrop(event, id)}
				>
					<button
						className={`collection-expand-button${isExpanded ? " expanded" : ""}`}
						type="button"
						disabled={!hasChildren}
						aria-label={isExpanded ? `折叠${node.collection.name}` : `展开${node.collection.name}`}
						onClick={() =>
							updateExpanded((ids) => {
								if (ids.has(id)) ids.delete(id);
								else ids.add(id);
								return ids;
							})
						}
					>
						›
					</button>
					<CollectionSelectionCheckbox
						label={node.collection.name}
						paperIds={membershipPaperIds[id] ?? []}
						selected={selectedPaperIds}
						disabled={membershipLoading}
						onToggle={onToggleSelection}
					/>
					{editingId === id ? (
						<input
							ref={editInputRef}
							className="collection-edit-input"
							value={editName}
							onChange={(event) => setEditName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void updateCollection(id, { name: editName });
							}}
						/>
					) : (
						<button className="collection-item" type="button" onClick={() => onSelect(id)}>
							<span className="collection-name">{node.collection.name}</span>
						</button>
					)}
					{editingId !== id && (
						<div className="collection-actions">
							<button
								className="collection-action-button"
								type="button"
								aria-label={`${node.collection.name}的更多操作`}
								title="更多操作"
								onMouseEnter={cancelMenuClose}
								onMouseLeave={scheduleMenuClose}
								onClick={() =>
									setMenu((current) => (current?.id === id ? undefined : { id, mode: "actions" }))
								}
							>
								⋯
							</button>
							{menu?.id === id && (
								<div
									className="collection-menu"
									role="menu"
									onMouseEnter={cancelMenuClose}
									onMouseLeave={scheduleMenuClose}
								>
									{menu.mode === "actions" ? (
										<>
											<button type="button" onClick={() => { setChildParentId(id); setChildName(""); setMenu(undefined); updateExpanded((ids) => ids.add(id)); }}>新建子分类</button>
											<button type="button" onClick={() => { setEditingId(id); setEditName(node.collection.name); setMenu(undefined); }}>重命名</button>
											<button type="button" onClick={() => setMenu({ id, mode: "move" })}>移动到</button>
											<button className="danger" type="button" onClick={() => void deleteCollection(node)}>删除</button>
										</>
									) : (
										<>
											<button type="button" onClick={() => setMenu({ id, mode: "actions" })}>返回</button>
											<button type="button" disabled={!node.collection.parentId} onClick={() => void updateCollection(id, { parentId: null })}>顶级分类</button>
											{moveDestinations.map((destination) => (
												<button type="button" key={destination.collection.id} disabled={node.collection.parentId === destination.collection.id} onClick={() => void updateCollection(id, { parentId: destination.collection.id })}>
													{destination.path.join(" / ")}
												</button>
											))}
										</>
									)}
								</div>
							)}
						</div>
					)}
				</div>
				{childParentId === id && (
					<div className="collection-child-editor">
						<input ref={childInputRef} value={childName} placeholder="子分类名称" onChange={(event) => setChildName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createCollection(childName, id); }} />
						<button type="button" disabled={!childName.trim() || busy} onClick={() => void createCollection(childName, id)}>新建</button>
						<button type="button" aria-label="取消" onClick={() => setChildParentId(undefined)}>×</button>
					</div>
				)}
				{hasChildren && isExpanded && <ul className="collection-children">{node.children.map(renderNode)}</ul>}
			</li>
		);
	}

	return (
		<aside className="collection-sidebar" ref={sidebarRef}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: This is the native drop target for restoring a top-level collection. */}
			<div
				className={`collection-sidebar-head${dropTargetId === null ? " drop-target" : ""}`}
				onDragOver={(event) => {
					if (!event.dataTransfer.types.includes(COLLECTION_DRAG_TYPE)) return;
					event.preventDefault();
					setDropTargetId(null);
				}}
				onDrop={(event) => void handleDrop(event, null)}
			>
				<strong>分类</strong>
			</div>
			<div className="collection-new-row">
				<input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createCollection(newName); }} placeholder="新建分类" />
				<button className="button secondary" type="button" disabled={busy || !newName.trim()} onClick={() => void createCollection(newName)}>新建</button>
			</div>

			<div className={`collection-node collection-system-node${activeCollection === "all" ? " active" : ""}`}>
				<span className="collection-system-spacer" />
				<CollectionSelectionCheckbox label="全部论文" paperIds={membershipPaperIds.all ?? []} selected={selectedPaperIds} disabled={membershipLoading} onToggle={onToggleSelection} />
				<button className="collection-item" type="button" onClick={() => onSelect("all")}><span className="collection-name">全部论文</span></button>
			</div>
			<div className={`collection-node collection-system-node${activeCollection === "__uncategorized__" ? " active" : ""}`}>
				<span className="collection-system-spacer" />
				<CollectionSelectionCheckbox label="未分类" paperIds={membershipPaperIds.__uncategorized__ ?? []} selected={selectedPaperIds} disabled={membershipLoading} onToggle={onToggleSelection} />
				<button className="collection-item" type="button" onClick={() => onSelect("__uncategorized__")}><span className="collection-name">未分类</span></button>
			</div>

			<ul className="collection-tree" aria-label="论文分类">
				{tree.map(renderNode)}
			</ul>
		</aside>
	);
}
