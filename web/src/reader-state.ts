// Pure reader helpers shared by the app shell and the reader page. Kept out of
// reader-page.tsx so lazy-loading the reader does not leak into the entry chunk.
import type { PaperRecord, PaperVersionView, ReaderState, ReaderWorkspaceTab } from "./types";

export function readerVersionState(paper: PaperRecord, namespace: string, version: PaperVersionView): ReaderState {
	return {
		title: paper.title,
		url: `/api/papers/${encodeURIComponent(paper.id)}/pdf/${version.sha256}?namespace=${encodeURIComponent(namespace)}`,
		pdfPath: version.blobPath,
		paperId: paper.id,
		namespace,
		sha256: version.sha256,
		bytes: version.bytes,
		retrievedAt: version.retrievedAt,
		versionKind: version.versionKind,
		versionLabel: version.versionLabel,
		translationOutputMode: version.translation?.outputMode,
	};
}

export function readerVersionName(version: Pick<ReaderState, "versionKind" | "versionLabel">): string {
	if (version.versionKind === "translation") return version.versionLabel ? `译文 · ${version.versionLabel}` : "译文";
	if (version.versionKind === "published") return version.versionLabel || "正式版本";
	if (version.versionKind === "preprint") return version.versionLabel || "预印本";
	if (version.versionKind === "supplement") return version.versionLabel || "补充材料";
	return version.versionLabel || "其他版本";
}

export function readerTabsStorageKey(reader: ReaderState): string | undefined {
	return reader.namespace && reader.paperId
		? `paper-agent-reader-tabs:${reader.namespace}:${reader.paperId}`
		: undefined;
}

export function restoredReaderTabs(reader: ReaderState): { tabs: ReaderWorkspaceTab[]; activeId?: string } {
	const key = readerTabsStorageKey(reader);
	if (!key) return { tabs: [{ id: "agent", kind: "agent", title: "AI 对话" }], activeId: "agent" };
	try {
		const raw = window.localStorage.getItem(key);
		if (!raw) return { tabs: [{ id: "agent", kind: "agent", title: "AI 对话" }], activeId: "agent" };
		const parsed = JSON.parse(raw) as { tabs?: ReaderWorkspaceTab[]; activeId?: string };
		const tabs = (parsed.tabs ?? []).filter(
			(tab): tab is ReaderWorkspaceTab =>
				tab?.kind === "agent" ||
				(tab?.kind === "note" && typeof tab.noteId === "string" && typeof tab.title === "string"),
		);
		return { tabs, activeId: tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : tabs[0]?.id };
	} catch {
		return { tabs: [{ id: "agent", kind: "agent", title: "AI 对话" }], activeId: "agent" };
	}
}
