import { QuickNotesPanel } from "./quick-notes-panel";
import { useRouterContext } from "./router";
import type { ReaderState } from "./types";

export default function QuickNotesPage({ onOpenReader }: { onOpenReader: (state: ReaderState) => void }) {
	const { navigate } = useRouterContext();
	return (
		<QuickNotesPanel onOpenReader={onOpenReader} onOpenPaper={(paperId) => navigate("library", { paper: paperId })} />
	);
}
