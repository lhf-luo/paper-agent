import { createHash } from "node:crypto";
import { ResearchNotebook } from "../../research/application/research-notebook.ts";
import {
	type CreateResearchNoteFolderInput,
	type CreateResearchNoteInput,
	type UpdateResearchNoteInput,
	uniquePaperIds,
	validateResearchNoteFolderName,
	validateResearchNoteMarkdown,
	validateResearchNoteTitle,
} from "../../research/domain/research-notes.ts";
import type {
	ConfirmationGrant,
	OperationPlan,
	PreparedOperation,
} from "../../shared/application/operation-consent.ts";
import { PaperAgentWiki } from "./paper-agent-wiki.ts";

export abstract class PaperAgentResearch extends PaperAgentWiki {
	researchNotebook(): ResearchNotebook {
		return new ResearchNotebook(this.personalStore());
	}

	async syncResearchNotes() {
		return this.researchNotebook().sync();
	}

	async listResearchNotes(query?: string, paperId?: string) {
		return this.researchNotebook().list(query, paperId);
	}

	async listResearchNoteFolders() {
		return this.researchNotebook().folders();
	}

	async getResearchNote(id: string) {
		return this.researchNotebook().get(id);
	}

	async listResearchNoteTemplates() {
		return this.researchNotebook().templates();
	}

	private async researchCreatePlan(input: CreateResearchNoteInput) {
		const notebook = this.researchNotebook();
		const title = validateResearchNoteTitle(input.title);
		const paperIds = uniquePaperIds(input.paperIds);
		const templateId = input.templateId && input.templateId !== "blank" ? input.templateId : undefined;
		const template = templateId ? await notebook.templateStore.get(templateId) : undefined;
		if (templateId && !template) throw new Error(`Research note template not found: ${templateId}`);
		const markdown = validateResearchNoteMarkdown(input.markdown ?? template?.markdown ?? "");
		for (const paperId of paperIds) {
			if (!(await this.personalStore().getPaper(paperId))) {
				throw new Error(`Research note paper is not in the personal workspace: ${paperId}`);
			}
		}
		if (input.folderId && !(await notebook.folders()).some((folder) => folder.id === input.folderId)) {
			throw new Error(`Research note folder is not in the personal workspace: ${input.folderId}`);
		}
		const plan: OperationPlan = {
			kind: "research-memory-write",
			summary: `Create Markdown research note: ${title}`,
			actor: "interactive-user",
			targets: [{ label: "Research note", value: `${title}`, risk: "low" }],
			details: {
				title,
				templateId,
				paperIds,
				contentHash: createHash("sha256").update(markdown).digest("hex"),
			},
		};
		return {
			input: {
				title,
				markdown,
				paperIds,
				...(templateId ? { templateId } : {}),
				...(input.folderId ? { folderId: input.folderId } : {}),
			},

			plan,
		};
	}

	async prepareResearchNoteCreate(input: CreateResearchNoteInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.researchCreatePlan(input)).plan);
	}

	async createResearchNote(input: CreateResearchNoteInput, grant: ConfirmationGrant) {
		const prepared = await this.researchCreatePlan(input);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook().create(prepared.input);
	}

	async updateResearchNote(id: string, input: UpdateResearchNoteInput) {
		return this.researchNotebook().update(id, input);
	}

	async setResearchNotePapers(id: string, paperIds: string[], expectedRevision: number) {
		return this.researchNotebook().setPapers(id, paperIds, expectedRevision);
	}

	private researchFolderPlan(input: CreateResearchNoteFolderInput) {
		const name = validateResearchNoteFolderName(input.name);
		const plan: OperationPlan = {
			kind: "research-memory-write",
			summary: `Create research note folder: ${name}`,
			actor: "interactive-user",
			targets: [{ label: "Research note folder", value: `${name}`, risk: "low" }],
			details: { name, parentId: input.parentId },
		};
		return { input: { name, parentId: input.parentId }, plan };
	}

	async prepareResearchNoteFolderCreate(input: CreateResearchNoteFolderInput) {
		return this.consent.prepare(this.researchFolderPlan(input).plan);
	}

	async createResearchNoteFolder(input: CreateResearchNoteFolderInput, grant: ConfirmationGrant) {
		const prepared = this.researchFolderPlan(input);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook().createFolder(prepared.input);
	}

	async updateResearchNoteFolder(id: string, input: { name: string; parentId?: string | null }) {
		return this.researchNotebook().updateFolder(id, input);
	}

	private async researchFolderDeletePlan(id: string) {
		const folder = (await this.researchNotebook().folders()).find((item) => item.id === id);
		if (!folder) throw new Error(`Research note folder not found: ${id}`);
		const plan: OperationPlan = {
			kind: "research-memory-delete",
			summary: `Delete research note folder: ${folder.name}`,
			actor: "interactive-user",
			targets: [{ label: "Research note folder", value: `${folder.name}`, risk: "high" }],
			details: { folderId: id },
		};
		return { plan };
	}

	async prepareResearchNoteFolderDelete(id: string) {
		return this.consent.prepare((await this.researchFolderDeletePlan(id)).plan);
	}

	async deleteResearchNoteFolder(id: string, grant: ConfirmationGrant) {
		const prepared = await this.researchFolderDeletePlan(id);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook().deleteFolder(id);
	}

	private async researchDeletePlan(id: string, author = "interactive-user") {
		const note = await this.researchNotebook().get(id);
		if (!note) throw new Error(`Research note not found: ${id}`);
		const plan: OperationPlan = {
			kind: "research-memory-delete",
			summary: `Delete Markdown research note: ${note.title}`,
			actor: author,
			targets: [{ label: "Research note", value: `${id}`, risk: "high" }],
			details: { noteId: id, revision: note.revision, paperIds: note.papers.map((paper) => paper.id) },
		};
		return { note, plan };
	}

	async prepareResearchNoteDelete(id: string, author?: string): Promise<PreparedOperation> {
		return this.consent.prepare((await this.researchDeletePlan(id, author)).plan);
	}

	async deleteResearchNote(id: string, grant: ConfirmationGrant, author?: string) {
		const prepared = await this.researchDeletePlan(id, author);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook().delete(id);
	}

	async openResearchTemplateDirectory() {
		const templates = this.researchNotebook().templateStore;
		await templates.initialize();
		const command =
			process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
		const result = await this.executor.exec(command, [templates.directory], { detached: true });
		if (result.code !== 0 || result.killed)
			throw new Error(result.stderr || "Could not open research template directory");
		return { opened: true, path: templates.directory };
	}
}
