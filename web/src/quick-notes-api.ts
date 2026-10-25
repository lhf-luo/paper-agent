import type { CreateQuickNoteInput, QuickNote, QuickNoteList } from "../../src/quick-notes/domain/quick-note.ts";
import { api, jsonBody } from "./api.js";
import { readerVersionState } from "./reader-state.js";
import type { ReaderPaperDetails, ReaderState } from "./types.js";

export type {
	CreateQuickNoteInput,
	QuickNote,
	QuickNoteList,
	QuickNotePaper,
} from "../../src/quick-notes/domain/quick-note.ts";
export const QUICK_NOTES_CHANGED = "paper-agent:quick-notes-changed";

export function notifyQuickNotesChanged() {
	window.dispatchEvent(new Event(QUICK_NOTES_CHANGED));
	// Storage events notify other tabs without putting record contents in browser storage.
	try {
		window.localStorage.setItem(QUICK_NOTES_CHANGED, crypto.randomUUID());
	} catch {
		/* The server remains authoritative. */
	}
}

export async function createQuickNote(input: CreateQuickNoteInput): Promise<QuickNote> {
	const { note } = await api<{ note: QuickNote }>("/api/quick-notes", jsonBody(input));
	notifyQuickNotesChanged();
	return note;
}

export async function openQuickNoteSource(note: QuickNote): Promise<ReaderState> {
	if (!note.paperAvailable) throw new Error("来源论文已删除，记录内容和来源快照仍然保留。");
	const { paper, versions } = await api<ReaderPaperDetails>(`/api/papers/${encodeURIComponent(note.paper.id)}`);
	const version = note.locator
		? versions.find((item) => item.sha256 === note.locator?.pdfSha256)
		: (versions.find((item) => item.isPreferred) ?? versions[0]);
	if (!version)
		throw new Error(
			note.locator ? "原 PDF 版本已不存在，可查看来源论文。" : "这篇论文还没有可阅读的 PDF，可查看来源论文。",
		);
	const state = readerVersionState(paper, version);
	if (note.locator) state.url += `#page=${note.locator.pages[0]}`;
	return state;
}

export function quickNotesList(params: URLSearchParams, signal?: AbortSignal): Promise<QuickNoteList> {
	return api(`/api/quick-notes?${params}`, { signal });
}
