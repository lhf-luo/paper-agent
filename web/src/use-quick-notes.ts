import { useCallback, useEffect, useState } from "react";
import { QUICK_NOTES_CHANGED, type QuickNoteList, quickNotesList } from "./quick-notes-api";

function useQuickNoteRefresh() {
	const [version, setVersion] = useState(0);
	const refresh = useCallback(() => setVersion((current) => current + 1), []);
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key === QUICK_NOTES_CHANGED) refresh();
		};
		window.addEventListener(QUICK_NOTES_CHANGED, refresh);
		window.addEventListener("focus", refresh);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(QUICK_NOTES_CHANGED, refresh);
			window.removeEventListener("focus", refresh);
			window.removeEventListener("storage", onStorage);
		};
	}, [refresh]);
	return { version, refresh };
}

export function useQuickNotes(fixedPaperId?: string) {
	const [query, setQuery] = useState("");
	const [paperId, setPaperId] = useState("");
	const [page, setPage] = useState(1);
	const [data, setData] = useState<QuickNoteList>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const { version, refresh } = useQuickNoteRefresh();
	// biome-ignore lint/correctness/useExhaustiveDependencies: version explicitly refreshes the same query after mutations.
	useEffect(() => {
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setLoading(true);
			setError("");
			const params = new URLSearchParams({ query, paperId: fixedPaperId ?? paperId, page: String(page) });
			void quickNotesList(params, controller.signal)
				.then((result) => {
					if (controller.signal.aborted) return;
					if (!result.notes.length && result.total > 0 && page > 1) {
						setPage(Math.max(1, Math.ceil(result.total / result.pageSize)));
					} else setData(result);
				})
				.catch((reason) => {
					if (!controller.signal.aborted) setError(String(reason));
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
		}, 150);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [query, paperId, fixedPaperId, page, version]);
	return {
		data,
		loading,
		error,
		refresh,
		query,
		paperId,
		page,
		setPage,
		setQuery: (value: string) => {
			setQuery(value);
			setPage(1);
		},
		setPaperId: (value: string) => {
			setPaperId(value);
			setPage(1);
		},
	};
}
