import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { type McpServerState, type McpView, playwrightMcpPreset } from "../../src/mcp/domain/mcp";
import { api, jsonBody } from "./api";
import "./mcp-panel.css";

interface EditorState {
	view?: McpView;
	draft: string;
	baseVersion: string;
	dirty: boolean;
	busy: boolean;
	error: string;
	message: string;
}
interface Editor {
	state: EditorState;
	set: Dispatch<SetStateAction<EditorState>>;
}
const empty: EditorState = { draft: "", baseVersion: "", dirty: false, busy: false, error: "", message: "" };
const statusLabels = {
	disabled: "已停用",
	disconnected: "未连接",
	connecting: "连接中",
	ready: "可用",
	error: "连接失败",
};
const accepted = (state: EditorState, view: McpView): EditorState => ({
	...state,
	view,
	draft: JSON.stringify(view.config, null, 2),
	baseVersion: view.version,
	dirty: false,
});

function useMcpEditor(active: boolean): Editor {
	const [state, set] = useState(empty);
	useEffect(() => {
		if (!active || state.busy) return;
		let cancelled = false;
		const refresh = async () => {
			try {
				const view = await api<McpView>("/api/mcp");
				if (!cancelled)
					set((previous) => (previous.baseVersion ? { ...previous, view } : accepted(previous, view)));
			} catch (reason) {
				if (!cancelled)
					set((previous) => ({ ...previous, error: String(reason instanceof Error ? reason.message : reason) }));
			}
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 5000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [active, state.busy]);
	useEffect(() => {
		if (!state.dirty) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [state.dirty]);
	return { state, set };
}

async function perform(editor: Editor, operation: () => Promise<Partial<EditorState>>) {
	editor.set((state) => ({ ...state, busy: true, error: "", message: "" }));
	try {
		const changes = await operation();
		editor.set((state) => ({ ...state, ...changes }));
	} catch (reason) {
		editor.set((state) => ({ ...state, error: reason instanceof Error ? reason.message : String(reason) }));
	} finally {
		editor.set((state) => ({ ...state, busy: false }));
	}
}

function addPlaywright(editor: Editor) {
	try {
		const config = JSON.parse(editor.state.draft || '{"mcpServers":{}}');
		if (config.mcpServers?.playwright) {
			editor.set((state) => ({ ...state, message: "已存在 playwright，请编辑现有配置。" }));
			return;
		}
		config.mcpServers = { ...config.mcpServers, playwright: playwrightMcpPreset() };
		editor.set((state) => ({ ...state, draft: JSON.stringify(config, null, 2), dirty: true, error: "" }));
	} catch {
		editor.set((state) => ({ ...state, error: "请先修正 JSON 配置。" }));
	}
}

async function save(editor: Editor) {
	await perform(editor, async () => {
		const config = JSON.parse(editor.state.draft);
		const view = await api<McpView>("/api/mcp", {
			method: "PUT",
			...jsonBody({ config, expectedVersion: editor.state.baseVersion }),
		});
		return { ...accepted(editor.state, view), message: "配置已保存，下次发送消息时加载。运行中的任务保持当前连接。" };
	});
}

async function toggle(editor: Editor, id: string) {
	await perform(editor, async () => {
		const view = editor.state.view!;
		const config = structuredClone(view.config);
		config.mcpServers[id].disabled = !config.mcpServers[id].disabled;
		const next = await api<McpView>("/api/mcp", {
			method: "PUT",
			...jsonBody({ config, expectedVersion: view.version }),
		});
		return accepted(editor.state, next);
	});
}

function ServerActions({ editor, server }: { editor: Editor; server: McpServerState }) {
	const { busy, dirty } = editor.state;
	const action = (kind: "test" | "disconnect") =>
		perform(editor, async () => ({
			view: await api<McpView>(`/api/mcp/${encodeURIComponent(server.id)}/${kind}`, { method: "POST" }),
		}));
	return (
		<div className="mcp-actions">
			<button
				type="button"
				className="button secondary"
				disabled={busy || dirty}
				onClick={() => void toggle(editor, server.id)}
			>
				{server.status === "disabled" ? "启用" : "停用"}
			</button>
			<button
				type="button"
				className="button secondary"
				disabled={busy || dirty || server.status === "disabled"}
				onClick={() => void action("test")}
			>
				测试连接
			</button>
			<button
				type="button"
				className="button secondary"
				disabled={busy || !server.connectionCount}
				onClick={() => void action("disconnect")}
			>
				断开
			</button>
		</div>
	);
}

function ServerCard({ editor, server }: { editor: Editor; server: McpServerState }) {
	return (
		<article className="mcp-server">
			<div className="mcp-server-heading">
				<strong>{server.id}</strong>
				<span>{statusLabels[server.status]}</span>
				<span className="muted">
					{server.toolNames.length} 个工具 · {server.connectionCount} 个会话连接
				</span>
			</div>
			<ServerActions editor={editor} server={server} />
			{server.error && <p className="mcp-error">{server.error}</p>}
			{server.toolNames.length > 0 && (
				<details>
					<summary>查看工具</summary>
					<ul>
						{server.toolNames.map((name) => (
							<li key={name}>
								<code>{name}</code>
							</li>
						))}
					</ul>
				</details>
			)}
		</article>
	);
}

function ConfigActions({ editor }: { editor: Editor }) {
	const { view, busy, dirty } = editor.state;
	return (
		<div className="mcp-actions">
			<button
				type="button"
				className="button secondary"
				disabled={busy || !view}
				onClick={() => addPlaywright(editor)}
			>
				添加 Playwright
			</button>
			<button
				type="button"
				className="button primary"
				disabled={busy || !dirty || !view}
				onClick={() => void save(editor)}
			>
				保存 MCP 配置
			</button>
			<button
				type="button"
				className="button secondary"
				disabled={busy || !view}
				onClick={() => void perform(editor, async () => accepted(editor.state, await api<McpView>("/api/mcp")))}
			>
				重新读取配置
			</button>
		</div>
	);
}

function ConfigEditor({ editor }: { editor: Editor }) {
	const { view, draft, busy, dirty } = editor.state;
	return (
		<>
			<ConfigActions editor={editor} />
			<label className="mcp-config">
				<span>服务配置（JSON，stdio）</span>
				<textarea
					spellCheck={false}
					rows={16}
					value={draft}
					disabled={busy || !view}
					onChange={(event) => editor.set((state) => ({ ...state, draft: event.target.value, dirty: true }))}
				/>
			</label>
			<small className="muted">
				支持标准 mcpServers 格式；环境变量值以 ******** 显示，保留该值即可沿用密钥。测试连接只验证协议和工具列表。
			</small>
			{view && <small className="muted mcp-path">{view.configPath}</small>}
			{dirty && <output>MCP 配置尚未保存。</output>}
		</>
	);
}

export function McpPanel({ active }: { active: boolean }) {
	const editor = useMcpEditor(active);
	const { view, error, message } = editor.state;
	return (
		<section className="panel form-panel mcp-panel">
			<span className="eyebrow">MCP · 浏览器与外部工具</span>
			<h2>浏览器与 MCP</h2>
			<p className="muted">
				通用、论文阅读和画布会话共用项目配置。浏览器首次调用时，请在 Chrome 中选择允许连接的标签页。
			</p>
			{error && (
				<div className="notice error" role="alert">
					{error}
				</div>
			)}
			{message && <output className="notice">{message}</output>}
			{view?.servers.map((server) => (
				<ServerCard key={server.id} editor={editor} server={server} />
			))}
			<ConfigEditor editor={editor} />
		</section>
	);
}
