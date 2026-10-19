import { useCallback, useEffect, useState } from "react";
import type { PiAuthPrompt, PiProviderView } from "../../src/agent/domain/pi-models";
import { api, jsonBody } from "./api";
import { AccessibleModal, ConsentCard, confirmOperation } from "./components";
import type { PreparedOperation } from "./types";

function usePiCredentialDraft(providerId: string) {
	const [prompt, setPrompt] = useState<PiAuthPrompt>();
	const [answers, setAnswers] = useState<string[]>([]),
		[value, setValue] = useState("");
	const [pending, setPending] = useState<{ operation: PreparedOperation; answers: string[] }>();
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const prepare = useCallback(
		async (values: string[]) => {
			setBusy(true);
			setError("");
			try {
				const result = await api<{ prompt?: PiAuthPrompt; prepared?: PreparedOperation }>(
					"/api/pi/auth/prepare",
					jsonBody({ providerId: providerId, answers: values }),
				);
				if (result.prompt) {
					setPrompt(result.prompt);
					setAnswers(values);
					setValue(result.prompt.options?.[0]?.id ?? "");
				}
				if (result.prepared) setPending({ operation: result.prepared, answers: values });
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		},
		[providerId],
	);
	useEffect(() => {
		void prepare([]);
	}, [prepare]);
	return {
		prompt,
		answers,
		setAnswers,
		value,
		setValue,
		pending,
		setPending,
		busy,
		setBusy,
		error,
		setError,
		prepare,
	};
}
async function savePiCredential(
	state: ReturnType<typeof usePiCredentialDraft>,
	providerId: string,
	onSaved: () => Promise<void>,
) {
	const { pending, busy, setBusy, setError, setAnswers, setValue, setPending } = state;
	if (!pending || busy) return;
	setBusy(true);
	setError("");
	try {
		const grant = await confirmOperation(pending.operation);
		await api("/api/pi/auth/execute", jsonBody({ providerId: providerId, answers: pending.answers, grant }));
		setAnswers([]);
		setValue("");
		setPending(undefined);
		await onSaved();
	} catch (e) {
		setPending(undefined);
		setError(e instanceof Error ? e.message : String(e));
	} finally {
		setBusy(false);
	}
}

export function PiCredentialDialog({
	provider,
	directory,
	onClose,
	onSaved,
}: {
	provider: PiProviderView;
	directory: string;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const state = usePiCredentialDraft(provider.id);
	return (
		<AccessibleModal
			title={`配置 ${provider.name}`}
			onClose={() => {
				if (!state.busy) onClose();
			}}
			maxWidth={580}
		>
			<p className="form-hint">
				使用 Pi 原生凭据流程，保存在 <code>{directory}/auth.json</code>。
			</p>
			{state.error && (
				<div className="error-banner" role="alert">
					{state.error}
				</div>
			)}
			{state.pending ? (
				<ConsentCard
					operation={state.pending.operation}
					busy={state.busy}
					onConfirm={() => savePiCredential(state, provider.id, onSaved)}
					onCancel={() => state.setPending(undefined)}
				/>
			) : (
				<CredentialForm state={state} onClose={onClose} />
			)}
		</AccessibleModal>
	);
}

function CredentialForm({ state, onClose }: { state: ReturnType<typeof usePiCredentialDraft>; onClose: () => void }) {
	return (
		<form
			className="form-grid"
			onSubmit={(e) => {
				e.preventDefault();
				void state.prepare([...state.answers, state.value]);
			}}
		>
			{state.prompt && (
				<CredentialField prompt={state.prompt} value={state.value} busy={state.busy} onChange={state.setValue} />
			)}
			<div className="button-row">
				<button type="button" className="button secondary" disabled={state.busy} onClick={onClose}>
					取消
				</button>
				<button
					type="submit"
					className="button primary"
					disabled={state.busy || !state.prompt || (state.prompt.type === "secret" && !state.value.trim())}
				>
					{state.busy ? "正在处理…" : "继续"}
				</button>
			</div>
		</form>
	);
}

function CredentialField({
	prompt,
	value,
	busy,
	onChange,
}: {
	prompt: PiAuthPrompt;
	value: string;
	busy: boolean;
	onChange: (value: string) => void;
}) {
	return (
		<label htmlFor="pi-credential-answer">
			{prompt.message}
			{prompt.type === "select" ? (
				<select id="pi-credential-answer" value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
					{prompt.options?.map((o) => (
						<option key={o.id} value={o.id}>
							{o.label}
						</option>
					))}
				</select>
			) : (
				<input
					id="pi-credential-answer"
					type={prompt.type === "secret" ? "password" : "text"}
					autoComplete="off"
					maxLength={16_384}
					disabled={busy}
					value={value}
					placeholder={prompt.placeholder}
					onChange={(e) => onChange(e.target.value)}
				/>
			)}
		</label>
	);
}
