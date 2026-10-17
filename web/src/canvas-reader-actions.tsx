import { useEffect, useRef, useState } from "react";

interface ReaderAction {
	id: number;
	kind: "confirm" | "prompt";
	title: string;
	value: string;
	resolve: (value: string | null | boolean) => void;
}
export function useCanvasReaderActions() {
	const [action, setAction] = useState<ReaderAction>();
	const pending = useRef<ReaderAction | undefined>(undefined),
		next = useRef(0);
	const finish = (value: string | null | boolean) => {
		pending.current?.resolve(value);
		pending.current = undefined;
		setAction(undefined);
	};
	const request = (kind: ReaderAction["kind"], title: string, value = "") =>
		new Promise<string | null | boolean>((resolve) => {
			pending.current?.resolve(pending.current.kind === "confirm" ? false : null);
			const a = { id: ++next.current, kind, title, value, resolve };
			pending.current = a;
			setAction(a);
		});
	useEffect(
		() => () => {
			pending.current?.resolve(pending.current.kind === "confirm" ? false : null);
		},
		[],
	);
	return {
		action,
		finish,
		confirmAction: async (message: string) => Boolean(await request("confirm", message)),
		promptAction: async (title: string, value: string) => {
			const result = await request("prompt", title, value);
			return typeof result === "string" ? result : null;
		},
	};
}
export function CanvasReaderAction({
	action,
	finish,
}: {
	action: ReaderAction;
	finish: (value: string | null | boolean) => void;
}) {
	const ref = useRef<HTMLDialogElement>(null),
		[value, setValue] = useState(action.value);
	const cancel = () => finish(action.kind === "confirm" ? false : null);
	useEffect(() => {
		ref.current?.showModal();
	}, []);
	return (
		<dialog
			ref={ref}
			className="canvas-reader-action"
			aria-label={action.title}
			onCancel={(e) => {
				e.preventDefault();
				cancel();
			}}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					finish(action.kind === "confirm" ? true : value);
				}}
			>
				<h3>{action.title}</h3>
				{action.kind === "prompt" && (
					<input aria-label={action.title} value={value} onChange={(e) => setValue(e.target.value)} />
				)}
				<div className="button-row">
					<button type="button" onClick={cancel}>
						取消
					</button>
					<button className="button" type="submit">
						确定
					</button>
				</div>
			</form>
		</dialog>
	);
}
