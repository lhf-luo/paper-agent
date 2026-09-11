export interface ResearchNotePaper {
	id: string;
	title: string;
}

export interface ResearchNoteSummary {
	id: string;
	title: string;
	relativePath: string;
	folderId?: string;
	folderPath?: string;
	templateId?: string;
	revision: number;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
	papers: ResearchNotePaper[];
}

export interface ResearchNote extends ResearchNoteSummary {
	markdown: string;
}

export interface ResearchNoteTemplate {
	id: string;
	name: string;
	filename?: string;
	markdown: string;
}

export interface CreateResearchNoteInput {
	title: string;
	markdown?: string;
	templateId?: string;
	paperIds?: string[];
	folderId?: string;
}

export interface UpdateResearchNoteInput {
	title: string;
	markdown: string;
	expectedRevision: number;
	expectedContentHash: string;
	paperIds?: string[];
	folderId?: string | null;
}

export interface ResearchNoteFolder {
	id: string;
	name: string;
	parentId?: string;
	relativePath: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateResearchNoteFolderInput {
	name: string;
	parentId?: string;
}

export interface UpdateResearchNoteFolderInput {
	name: string;
	parentId?: string | null;
}

export interface ResearchNoteSyncResult {
	createdNotes: number;
	updatedNotes: number;
	deletedNotes: number;
	createdFolders: number;
	deletedFolders: number;
	warnings: string[];
}

export function validateResearchNoteTitle(value: string): string {
	const title = value.trim();
	if (!title) throw new Error("Note title is required");
	if (title.length > 300) throw new Error("Note title must not exceed 300 characters");
	if (/\p{Cc}/u.test(title)) throw new Error("Note title must not contain control characters");
	return title;
}

export function validateResearchNoteFolderName(value: string): string {
	const name = value.trim();
	if (!name) throw new Error("Folder name is required");
	if (name.length > 128) throw new Error("Folder name must not exceed 128 characters");
	if (/[\\/:*?"<>|\p{Cc}]/u.test(name)) throw new Error("Folder name contains invalid characters");
	return name;
}

export function validateResearchNoteMarkdown(value: string): string {
	if (typeof value !== "string") throw new Error("Note content must be Markdown text");
	if (Buffer.byteLength(value, "utf8") > 2 * 1024 * 1024) {
		throw new Error("Note content must not exceed 2 MB");
	}
	return value;
}

export function uniquePaperIds(values: string[] = []): string[] {
	const result: string[] = [];
	for (const value of values) {
		const id = value.trim();
		if (!id || id.length > 512 || /\p{Cc}/u.test(id)) throw new Error("Paper id is invalid");
		if (!result.includes(id)) result.push(id);
	}
	return result;
}
