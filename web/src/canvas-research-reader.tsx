import { lazy, Suspense, useEffect, useRef } from "react";
import { CanvasReaderAction, useCanvasReaderActions } from "./canvas-reader-actions";
import type { ReaderState } from "./types";

const ReaderPage = lazy(() => import("./reader-page").then((module) => ({ default: module.ReaderPage })));
export function CanvasResearchReader({ reader, onClose }: { reader: ReaderState; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	const actions = useCanvasReaderActions();
	useEffect(() => {
		ref.current?.showModal();
	}, []);
	return (
		<dialog
			ref={ref}
			className="canvas-research-reader"
			aria-label="画布中的个人阅读工作台"
			onCancel={(e) => {
				e.preventDefault();
				ref.current?.close();
			}}
			onClose={onClose}
		>
			<Suspense fallback={<output>正在打开个人阅读工作台…</output>}>
				<ReaderPage
					reader={reader}
					onBack={() => ref.current?.close()}
					backLabel="返回关系画布"
					confirmAction={actions.confirmAction}
					promptAction={actions.promptAction}
				/>
			</Suspense>
			{actions.action && (
				<CanvasReaderAction key={actions.action.id} action={actions.action} finish={actions.finish} />
			)}
		</dialog>
	);
}
