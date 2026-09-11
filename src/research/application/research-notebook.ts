import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import type {
	CreateResearchNoteFolderInput,
	CreateResearchNoteInput,
	ResearchNote,
	ResearchNoteSummary,
	ResearchNoteTemplate,
	UpdateResearchNoteFolderInput,
	UpdateResearchNoteInput,
} from "../domain/research-notes.ts";
import { ResearchTemplateStore } from "../infrastructure/research-template-store.ts";

export class ResearchNotebook {
	readonly templateStore: ResearchTemplateStore;
	private readonly store: LiteratureStore;

	constructor(store: LiteratureStore) {
		this.store = store;
		this.templateStore = new ResearchTemplateStore(store.personalDataRoot);
	}

	async list(query?: string, paperId?: string): Promise<ResearchNoteSummary[]> {
		await this.store.syncResearchNotes();
		return this.store.listResearchNotes(query, paperId);
	}

	async get(id: string): Promise<ResearchNote | undefined> {
		await this.store.syncResearchNotes();
		return this.store.getResearchNote(id);
	}

	async sync() {
		return this.store.syncResearchNotes();
	}

	async templates(): Promise<ResearchNoteTemplate[]> {
		return this.templateStore.list();
	}

	async folders() {
		await this.store.syncResearchNotes();
		return this.store.listResearchNoteFolders();
	}

	async createFolder(input: CreateResearchNoteFolderInput) {
		await this.store.syncResearchNotes();
		return this.store.createResearchNoteFolder(input);
	}

	async updateFolder(id: string, input: UpdateResearchNoteFolderInput) {
		await this.store.syncResearchNotes();
		return this.store.updateResearchNoteFolder(id, input);
	}

	async deleteFolder(id: string) {
		await this.store.syncResearchNotes();
		return this.store.deleteResearchNoteFolder(id);
	}

	async create(input: CreateResearchNoteInput): Promise<ResearchNote> {
		await this.store.syncResearchNotes();
		const templateId = input.templateId && input.templateId !== "blank" ? input.templateId : undefined;
		const template = templateId ? await this.templateStore.get(templateId) : undefined;
		if (templateId && !template) throw new Error(`Research note template not found: ${templateId}`);
		return this.store.createResearchNote({
			...input,
			markdown: input.markdown ?? template?.markdown ?? "",
			...(templateId ? { templateId } : {}),
		});
	}

	async update(id: string, input: UpdateResearchNoteInput): Promise<ResearchNote> {
		await this.store.syncResearchNotes();
		return this.store.updateResearchNote(id, input);
	}

	async setPapers(id: string, paperIds: string[], expectedRevision: number): Promise<ResearchNote> {
		await this.store.syncResearchNotes();
		return this.store.setResearchNotePapers(id, paperIds, expectedRevision);
	}

	async delete(id: string): Promise<ResearchNote | undefined> {
		await this.store.syncResearchNotes();
		return this.store.deleteResearchNote(id);
	}
}
