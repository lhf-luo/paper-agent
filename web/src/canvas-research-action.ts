import { useCallback, useState } from "react";

export function useResearchAction() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const perform = useCallback(async (action: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await action();
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setBusy(false);
		}
	}, []);
	return { busy, error, perform };
}
