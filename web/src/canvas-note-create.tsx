import { useRef, useState } from "react";
import { api, jsonBody } from "./api";
import { ConsentCard, confirmOperation } from "./components";
import { useAutomaticOperationConfirmation } from "./confirmation-policy";
import type { PreparedOperation, ResearchNote, ResearchNoteFolder } from "./types";

interface Props {
	namespace: string;
	folders: ResearchNoteFolder[];
	initialTitle: string;
	initialFolderId: string;
	beforeCreate: () => Promise<void>;
	onCreated: (note: ResearchNote) => void;
	onBusyChange: (busy: boolean) => void;
}
interface Draft {
	title: string;
	folderId: string;
}
interface Pending {
	operation: PreparedOperation;
	payload: Record<string, unknown>;
}
function folderLabel(folder: ResearchNoteFolder, folders: ResearchNoteFolder[]): string {
	const names = [folder.name],
		visited = new Set([folder.id]);
	let parentId = folder.parentId;
	while (parentId && !visited.has(parentId)) {
		visited.add(parentId);
		const parent = folders.find((item) => item.id === parentId);
		if (!parent) break;
		names.unshift(parent.name);
		parentId = parent.parentId;
	}
	return names.join(" / ");
}

async function createPreparedNote(pending: Pending): Promise<ResearchNote> {
	const grant = await confirmOperation(pending.operation);
	const result = await api<{ note: ResearchNote }>(
		"/api/research/notes/create/execute",
		jsonBody({ ...pending.payload, grant }),
	);
	return result.note;
}
function useNoteCreation(props: Props) {
	const [draft, setDraft] = useState<Draft>({ title: props.initialTitle, folderId: props.initialFolderId });
	const [pending, setPending] = useState<Pending>();
	const [created, setCreated] = useState<ResearchNote>();
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const inFlight = useRef(false);
	const work = async (action: () => Promise<void>) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		props.onBusyChange(true);
		setError("");
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			inFlight.current = false;
			setBusy(false);
			props.onBusyChange(false);
		}
	};
	const prepare = () =>
		work(async () => {
			if (!draft.title.trim()) throw new Error("请输入笔记名称");
			await props.beforeCreate();
			const payload = {
				namespace: props.namespace,
				title: draft.title.trim(),
				markdown: "",
				templateId: "blank",
				paperIds: [],
				...(draft.folderId ? { folderId: draft.folderId } : {}),
			};
			const operation = await api<PreparedOperation>("/api/research/notes/create/prepare", jsonBody(payload));
			setPending({ operation, payload });
		});
	const execute = () =>
		work(async () => {
			if (!pending && !created) return;
			const note =
				created ??
				(await createPreparedNote(pending!).catch((error) => {
					setPending(undefined);
					throw error;
				}));
			setCreated(note);
			props.onCreated(note);
		});
	const confirmation = useAutomaticOperationConfirmation(pending?.operation, busy, execute);
	return { draft, setDraft, pending, setPending, created, busy, error, prepare, execute, confirmation };
}
function NoteFields({ state, folders }: { state: ReturnType<typeof useNoteCreation>; folders: ResearchNoteFolder[] }) {
	return (
		<fieldset disabled={state.busy || Boolean(state.pending || state.created)}>
			<label>
				笔记名称
				<input
					required
					maxLength={300}
					value={state.draft.title}
					onChange={(e) => state.setDraft((d) => ({ ...d, title: e.target.value }))}
				/>
			</label>
			<label>
				文件夹
				<select
					value={state.draft.folderId}
					onChange={(e) => state.setDraft((d) => ({ ...d, folderId: e.target.value }))}
				>
					<option value="">未归档</option>
					{folders.map((folder) => (
						<option key={folder.id} value={folder.id}>
							{folderLabel(folder, folders)}
						</option>
					))}
				</select>
			</label>
		</fieldset>
	);
}
export function CanvasNoteCreate(props: Props) {
	const state = useNoteCreation(props);
	return (
		<form
			className="research-canvas-note-create"
			onSubmit={(e) => {
				e.preventDefault();
				if (!state.pending) void state.prepare();
			}}
		>
			<div className="research-canvas-note-create-body">
				<NoteFields state={state} folders={props.folders} />
				{state.error && <p role="alert">{state.error}</p>}
				{state.pending &&
					!state.created &&
					(state.confirmation.confirmationRequired || state.confirmation.automaticAttemptFailed) && (
						<ConsentCard
							operation={state.pending.operation}
							busy={state.busy}
							onCancel={() => state.setPending(undefined)}
							onConfirm={state.execute}
						/>
					)}
			</div>
			<footer>
				{state.created ? (
					<button className="primary" type="button" disabled={state.busy} onClick={() => void state.execute()}>
						加入画布
					</button>
				) : (
					<button
						className="primary"
						type="submit"
						disabled={state.busy || Boolean(state.pending) || !state.draft.title.trim()}
					>
						{state.busy ? "正在创建…" : "创建并加入画布"}
					</button>
				)}
			</footer>
		</form>
	);
}
