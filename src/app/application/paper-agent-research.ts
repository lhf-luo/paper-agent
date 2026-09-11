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
	researchNotebook(namespace = this.defaultNamespace): ResearchNotebook {
		return new ResearchNotebook(this.personalStore(namespace));
	}

	async syncResearchNotes(namespace = this.defaultNamespace) {
		return this.researchNotebook(namespace).sync();
	}

	async listResearchNotes(namespace = this.defaultNamespace, query?: string, paperId?: string) {
		return this.researchNotebook(namespace).list(query, paperId);
	}

	async listResearchNoteFolders(namespace = this.defaultNamespace) {
		return this.researchNotebook(namespace).folders();
	}

	async getResearchNote(id: string, namespace = this.defaultNamespace) {
		return this.researchNotebook(namespace).get(id);
	}

	async listResearchNoteTemplates(namespace = this.defaultNamespace) {
		return this.researchNotebook(namespace).templates();
	}

	private async researchCreatePlan(input: CreateResearchNoteInput, namespace = this.defaultNamespace) {
		const notebook = this.researchNotebook(namespace);
		const title = validateResearchNoteTitle(input.title);
		const paperIds = uniquePaperIds(input.paperIds);
		const templateId = input.templateId && input.templateId !== "blank" ? input.templateId : undefined;
		const template = templateId ? await notebook.templateStore.get(templateId) : undefined;
		if (templateId && !template) throw new Error(`Research note template not found: ${templateId}`);
		const markdown = validateResearchNoteMarkdown(input.markdown ?? template?.markdown ?? "");
		for (const paperId of paperIds) {
			if (!(await this.personalStore(namespace).getPaper(paperId))) {
				throw new Error(`Research note paper is not in namespace ${namespace}: ${paperId}`);
			}
		}
		if (input.folderId && !(await notebook.folders()).some((folder) => folder.id === input.folderId)) {
			throw new Error(`Research note folder is not in namespace ${namespace}: ${input.folderId}`);
		}
		const plan: OperationPlan = {
			kind: "research-memory-write",
			summary: `Create Markdown research note: ${title}`,
			actor: "interactive-user",
			targets: [{ label: "Research note", value: `${namespace}/${title}`, risk: "low" }],
			details: {
				namespace,
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
			namespace,
			plan,
		};
	}

	async prepareResearchNoteCreate(input: CreateResearchNoteInput, namespace?: string): Promise<PreparedOperation> {
		return this.consent.prepare((await this.researchCreatePlan(input, namespace)).plan);
	}

	async createResearchNote(input: CreateResearchNoteInput, grant: ConfirmationGrant, namespace?: string) {
		const prepared = await this.researchCreatePlan(input, namespace);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook(prepared.namespace).create(prepared.input);
	}

	async updateResearchNote(id: string, input: UpdateResearchNoteInput, namespace?: string) {
		return this.researchNotebook(namespace).update(id, input);
	}

	async setResearchNotePapers(id: string, paperIds: string[], expectedRevision: number, namespace?: string) {
		return this.researchNotebook(namespace).setPapers(id, paperIds, expectedRevision);
	}

	private researchFolderPlan(input: CreateResearchNoteFolderInput, namespace = this.defaultNamespace) {
		const name = validateResearchNoteFolderName(input.name);
		const plan: OperationPlan = {
			kind: "research-memory-write",
			summary: `Create research note folder: ${name}`,
			actor: "interactive-user",
			targets: [{ label: "Research note folder", value: `${namespace}/${name}`, risk: "low" }],
			details: { namespace, name, parentId: input.parentId },
		};
		return { input: { name, parentId: input.parentId }, namespace, plan };
	}

	async prepareResearchNoteFolderCreate(input: CreateResearchNoteFolderInput, namespace?: string) {
		return this.consent.prepare(this.researchFolderPlan(input, namespace).plan);
	}

	async createResearchNoteFolder(input: CreateResearchNoteFolderInput, grant: ConfirmationGrant, namespace?: string) {
		const prepared = this.researchFolderPlan(input, namespace);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook(prepared.namespace).createFolder(prepared.input);
	}

	async updateResearchNoteFolder(
		id: string,
		input: { name: string; parentId?: string | null },
		namespace = this.defaultNamespace,
	) {
		return this.researchNotebook(namespace).updateFolder(id, input);
	}

	private async researchFolderDeletePlan(id: string, namespace = this.defaultNamespace) {
		const folder = (await this.researchNotebook(namespace).folders()).find((item) => item.id === id);
		if (!folder) throw new Error(`Research note folder not found: ${id}`);
		const plan: OperationPlan = {
			kind: "research-memory-delete",
			summary: `Delete research note folder: ${folder.name}`,
			actor: "interactive-user",
			targets: [{ label: "Research note folder", value: `${namespace}/${folder.name}`, risk: "high" }],
			details: { namespace, folderId: id },
		};
		return { namespace, plan };
	}

	async prepareResearchNoteFolderDelete(id: string, namespace?: string) {
		return this.consent.prepare((await this.researchFolderDeletePlan(id, namespace)).plan);
	}

	async deleteResearchNoteFolder(id: string, grant: ConfirmationGrant, namespace?: string) {
		const prepared = await this.researchFolderDeletePlan(id, namespace);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook(prepared.namespace).deleteFolder(id);
	}

	private async researchDeletePlan(id: string, author = "interactive-user", namespace = this.defaultNamespace) {
		const note = await this.researchNotebook(namespace).get(id);
		if (!note) throw new Error(`Research note not found: ${id}`);
		const plan: OperationPlan = {
			kind: "research-memory-delete",
			summary: `Delete Markdown research note: ${note.title}`,
			actor: author,
			targets: [{ label: "Research note", value: `${namespace}/${id}`, risk: "high" }],
			details: { namespace, noteId: id, revision: note.revision, paperIds: note.papers.map((paper) => paper.id) },
		};
		return { note, namespace, plan };
	}

	async prepareResearchNoteDelete(id: string, author?: string, namespace?: string): Promise<PreparedOperation> {
		return this.consent.prepare((await this.researchDeletePlan(id, author, namespace)).plan);
	}

	async deleteResearchNote(id: string, grant: ConfirmationGrant, author?: string, namespace?: string) {
		const prepared = await this.researchDeletePlan(id, author, namespace);
		await this.consent.consume(grant, prepared.plan);
		return this.researchNotebook(prepared.namespace).delete(id);
	}

	async openResearchTemplateDirectory(namespace = this.defaultNamespace) {
		const templates = this.researchNotebook(namespace).templateStore;
		await templates.initialize();
		const command =
			process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
		const result = await this.executor.exec(command, [templates.directory], { detached: true });
		if (result.code !== 0 || result.killed)
			throw new Error(result.stderr || "Could not open research template directory");
		return { opened: true, path: templates.directory };
	}
}
