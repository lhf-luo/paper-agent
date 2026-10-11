import { EditorContent, useEditor } from "@tiptap/react";
import { Bold, ExternalLink, Italic, Link2, Maximize2, Minimize2, Table2, Underline, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	type CanvasRichContent,
	parseCanvasRichContent,
	validCanvasUrl,
} from "../../src/canvas/domain/canvas-rich-content";
import { canvasTextExtensions } from "./canvas-rich-text";
import "./canvas-text-editor.css";

interface EditorPosition {
	left: number;
	top: number;
	width: number;
	height: number;
}

export function CanvasTextEditor({
	document,
	portal,
	position,
	onSave,
	onCancel,
}: {
	document: CanvasRichContent;
	portal: HTMLElement;
	position: EditorPosition;
	onSave: (content: CanvasRichContent) => void;
	onCancel: () => void;
}) {
	const [fullscreen, setFullscreen] = useState(false);
	const [tableMenu, setTableMenu] = useState(false);
	const [tableRows, setTableRows] = useState("3");
	const [tableColumns, setTableColumns] = useState("3");
	const [tableSizeError, setTableSizeError] = useState("");
	const [linkDialog, setLinkDialog] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const [error, setError] = useState("");
	const [pendingLeave, setPendingLeave] = useState<{ proceed?: () => void } | null>(null);
	const keepEditingRef = useRef<HTMLButtonElement>(null);
	const [, setTick] = useState(0);
	const initialJson = useRef<string | null>(null);
	const editor = useEditor({
		extensions: canvasTextExtensions,
		content: document,
		onUpdate: () => setTick((value) => value + 1),
		onSelectionUpdate: () => setTick((value) => value + 1),
	});
	if (editor && initialJson.current === null) initialJson.current = JSON.stringify(editor.getJSON());
	const isDirty = useCallback(() => !!editor && JSON.stringify(editor.getJSON()) !== initialJson.current, [editor]);
	useEffect(() => {
		if (pendingLeave) keepEditingRef.current?.focus();
	}, [pendingLeave]);
	useEffect(() => {
		if (!editor) return;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!isDirty()) return;
			event.preventDefault();
			event.returnValue = "";
		};
		const beforeRoute = (event: Event) => {
			if (!isDirty()) return;
			event.preventDefault();
			const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
			setPendingLeave({ proceed });
		};
		window.addEventListener("beforeunload", beforeUnload);
		window.addEventListener("paper-agent:before-route", beforeRoute);
		return () => {
			window.removeEventListener("beforeunload", beforeUnload);
			window.removeEventListener("paper-agent:before-route", beforeRoute);
		};
	}, [editor, isDirty]);
	if (!editor) return null;
	const cancel = () => {
		if (isDirty()) {
			setPendingLeave({});
			return;
		}
		onCancel();
	};
	const command = (label: string, run: () => void, active = false, disabled = false) => (
		<button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={run}>
			{label}
		</button>
	);
	const save = () => {
		try {
			onSave(parseCanvasRichContent(editor.getJSON()));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};
	const confirmLeave = (saveChanges: boolean) => {
		const proceed = pendingLeave?.proceed;
		if (saveChanges) {
			try {
				onSave(parseCanvasRichContent(editor.getJSON()));
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
				setPendingLeave(null);
				return;
			}
		} else {
			onCancel();
		}
		proceed?.();
	};
	const keepEditing = () => {
		setPendingLeave(null);
		window.requestAnimationFrame(() => editor.commands.focus());
	};
	const addLink = () => {
		const href = linkUrl.trim();
		if (!validCanvasUrl(href)) {
			setError("请输入完整的 http 或 https 链接。");
			return;
		}
		if (editor.state.selection.empty) {
			editor
				.chain()
				.focus()
				.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
				.run();
		} else {
			editor.chain().focus().setLink({ href }).run();
		}
		setError("");
		setLinkDialog(false);
	};
	const insertTable = () => {
		const rows = Number(tableRows);
		const cols = Number(tableColumns);
		if (
			!Number.isSafeInteger(rows) ||
			rows < 1 ||
			rows > 30 ||
			!Number.isSafeInteger(cols) ||
			cols < 1 ||
			cols > 20
		) {
			setTableSizeError("行数请输入 1–30，列数请输入 1–20。");
			return;
		}
		if (!editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()) {
			setTableSizeError("无法在当前位置插入表格，请将光标移到普通段落中。");
			return;
		}
		setTableSizeError("");
		setTableMenu(false);
	};
	const toolbarWidth = Math.min(560, portal.clientWidth - 24);
	const toolbarLeft = Math.max(
		12 - position.left,
		Math.min(0, portal.clientWidth - 12 - position.left - toolbarWidth),
	);
	return createPortal(
		<>
			<button
				type="button"
				className="research-canvas-text-editor-backdrop"
				aria-label="取消文本编辑"
				onClick={cancel}
			/>
			<div
				className={`research-canvas-text-editor${fullscreen ? " fullscreen" : ""}${position.top < 90 ? " toolbar-below" : ""}`}
				role="dialog"
				aria-label="文本编辑器"
				style={fullscreen ? undefined : position}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => event.stopPropagation()}
				onWheel={(event) => event.stopPropagation()}
				onContextMenu={(event) => event.stopPropagation()}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						if (linkDialog) setLinkDialog(false);
						else if (fullscreen) setFullscreen(false);
						else cancel();
					} else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
						event.preventDefault();
						event.stopPropagation();
						save();
					} else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
						event.preventDefault();
						event.stopPropagation();
						setLinkUrl(editor.getAttributes("link").href ?? "");
						setLinkDialog(true);
					} else if (event.ctrlKey || event.metaKey) {
						event.stopPropagation();
					}
				}}
			>
				<div className="research-canvas-text-editor-top">
					<strong>编辑文本</strong>
					<button type="button" onClick={() => setFullscreen((value) => !value)}>
						{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
						{fullscreen ? "退出全屏" : "全屏编辑"}
					</button>
					<button type="button" aria-label="取消编辑" onClick={cancel}>
						<X size={17} />
					</button>
				</div>
				<div
					className="research-canvas-text-editor-toolbar"
					role="toolbar"
					aria-label="文本格式"
					style={fullscreen ? undefined : { width: toolbarWidth, left: toolbarLeft }}
				>
					<button
						type="button"
						title="加粗"
						aria-label="加粗"
						aria-pressed={editor.isActive("bold")}
						onClick={() => editor.chain().focus().toggleBold().run()}
					>
						<Bold size={16} />
					</button>
					<button
						type="button"
						title="斜体"
						aria-label="斜体"
						aria-pressed={editor.isActive("italic")}
						onClick={() => editor.chain().focus().toggleItalic().run()}
					>
						<Italic size={16} />
					</button>
					<button
						type="button"
						title="下划线"
						aria-label="下划线"
						aria-pressed={editor.isActive("underline")}
						onClick={() => editor.chain().focus().toggleUnderline().run()}
					>
						<Underline size={16} />
					</button>
					{command("正文", () => editor.chain().focus().setParagraph().run(), editor.isActive("paragraph"))}
					{([1, 2, 3] as const).map((level) =>
						command(
							`H${level}`,
							() => editor.chain().focus().toggleHeading({ level }).run(),
							editor.isActive("heading", { level }),
						),
					)}
					<button
						type="button"
						title="插入或编辑链接"
						aria-label="插入或编辑链接"
						onClick={() => {
							setLinkUrl(editor.getAttributes("link").href ?? "");
							setLinkDialog(true);
						}}
					>
						<Link2 size={16} />
					</button>
					{editor.isActive("link") && (
						<button type="button" title="移除链接" onClick={() => editor.chain().focus().unsetLink().run()}>
							<ExternalLink size={16} />
						</button>
					)}
					<button
						type="button"
						title="表格操作"
						aria-label="表格操作"
						aria-expanded={tableMenu}
						onClick={() => setTableMenu((value) => !value)}
					>
						<Table2 size={16} />
					</button>
				</div>
				{tableMenu && (
					<div className="research-canvas-text-table-menu">
						<form
							className="research-canvas-text-table-insert"
							noValidate
							onSubmit={(event) => {
								event.preventDefault();
								insertTable();
							}}
						>
							<strong>插入表格</strong>
							<div className="research-canvas-text-table-size">
								<label>
									行数
									<input
										type="number"
										min="1"
										max="30"
										required
										value={tableRows}
										onChange={(event) => {
											setTableRows(event.target.value);
											setTableSizeError("");
										}}
									/>
								</label>
								<span aria-hidden="true">×</span>
								<label>
									列数
									<input
										type="number"
										min="1"
										max="20"
										required
										value={tableColumns}
										onChange={(event) => {
											setTableColumns(event.target.value);
											setTableSizeError("");
										}}
									/>
								</label>
								<button type="submit">插入</button>
							</div>
							{tableSizeError && <small role="alert">{tableSizeError}</small>}
						</form>
						{command(
							"上方插入行",
							() => editor.chain().focus().addRowBefore().run(),
							false,
							!editor.isActive("table"),
						)}
						{command(
							"下方插入行",
							() => editor.chain().focus().addRowAfter().run(),
							false,
							!editor.isActive("table"),
						)}
						{command(
							"左侧插入列",
							() => editor.chain().focus().addColumnBefore().run(),
							false,
							!editor.isActive("table"),
						)}
						{command(
							"右侧插入列",
							() => editor.chain().focus().addColumnAfter().run(),
							false,
							!editor.isActive("table"),
						)}
						{command(
							"删除当前行",
							() => editor.chain().focus().deleteRow().run(),
							false,
							!editor.isActive("table"),
						)}
						{command(
							"删除当前列",
							() => editor.chain().focus().deleteColumn().run(),
							false,
							!editor.isActive("table"),
						)}
						{command(
							"切换表头行",
							() => editor.chain().focus().toggleHeaderRow().run(),
							false,
							!editor.isActive("table"),
						)}
						{command(
							"合并单元格",
							() => editor.chain().focus().mergeCells().run(),
							false,
							!editor.can().mergeCells(),
						)}
						{command(
							"拆分单元格",
							() => editor.chain().focus().splitCell().run(),
							false,
							!editor.can().splitCell(),
						)}
						{command(
							"删除表格",
							() => {
								editor.chain().focus().deleteTable().run();
								setTableMenu(false);
							},
							false,
							!editor.isActive("table"),
						)}
					</div>
				)}
				{linkDialog && (
					<form
						className="research-canvas-text-link-dialog"
						onSubmit={(event) => {
							event.preventDefault();
							addLink();
						}}
					>
						<label>
							链接地址{" "}
							<input
								type="url"
								value={linkUrl}
								placeholder="https://example.com"
								onChange={(event) => setLinkUrl(event.target.value)}
							/>
						</label>
						<button type="submit">应用</button>
						<button type="button" onClick={() => setLinkDialog(false)}>
							取消
						</button>
					</form>
				)}
				<div className="research-canvas-text-editor-body">
					<EditorContent editor={editor} />
				</div>
				{error && (
					<p className="research-canvas-text-editor-error" role="alert">
						{error}
					</p>
				)}
				<div className="research-canvas-text-editor-actions">
					<button type="button" onClick={cancel}>
						取消
					</button>
					<button type="button" className="primary" onClick={save}>
						保存
					</button>
				</div>
			</div>
			{pendingLeave && (
				<div className="research-canvas-text-leave-backdrop">
					<div
						className="research-canvas-text-leave-dialog"
						role="dialog"
						aria-modal="true"
						aria-label="未保存的文本修改"
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								keepEditing();
							}
						}}
					>
						<strong>文本尚未保存</strong>
						<p>保存修改后继续，或放弃这次修改。</p>
						<div className="research-canvas-text-leave-actions">
							<button type="button" ref={keepEditingRef} onClick={keepEditing}>
								继续编辑
							</button>
							<button type="button" onClick={() => confirmLeave(false)}>
								放弃修改
							</button>
							<button type="button" className="primary" onClick={() => confirmLeave(true)}>
								保存修改
							</button>
						</div>
					</div>
				</div>
			)}
		</>,
		portal,
	);
}
