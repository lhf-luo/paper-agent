import type { IncomingMessage, ServerResponse } from "node:http";
import type { CreateResearchNoteInput, UpdateResearchNoteInput } from "../../research/domain/research-notes.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, grantFromBody, json, readJson } from "./web-http.ts";

function noteIdFromPath(pathname: string): string | undefined {
	const match = /^\/api\/research\/notes\/([^/]+)(?:\/papers)?$/.exec(pathname);
	return match ? decodeURIComponent(match[1]) : undefined;
}

function creationInput(body: Record<string, unknown>): CreateResearchNoteInput {
	if (typeof body.title !== "string") throw new ApiError(400, "title is required");
	return {
		title: body.title,
		...(typeof body.markdown === "string" ? { markdown: body.markdown } : {}),
		...(typeof body.templateId === "string" ? { templateId: body.templateId } : {}),
		paperIds: Array.isArray(body.paperIds)
			? body.paperIds.filter((value): value is string => typeof value === "string")
			: [],
		...(typeof body.folderId === "string" ? { folderId: body.folderId } : {}),
	};
}

function folderIdFromPath(pathname: string): string | undefined {
	const match = /^\/api\/research\/folders\/([^/]+)$/.exec(pathname);
	return match ? decodeURIComponent(match[1]) : undefined;
}

function conflictAware(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	if (/changed since|revision conflict/i.test(message)) throw new ApiError(409, message);
	throw error;
}

export async function handleResearchRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/research/")) return false;
	if (request.method === "GET" && url.pathname === "/api/research/templates") {
		json(response, 200, { templates: await application.listResearchNoteTemplates() });
		return true;
	}
	if (request.method === "GET" && url.pathname === "/api/research/folders") {
		json(response, 200, { folders: await application.listResearchNoteFolders() });
		return true;
	}
	if (request.method === "GET" && ["/api/research/notes", "/api/research/note-index"].includes(url.pathname)) {
		const notes = await application.listResearchNotes(
			url.searchParams.get("query") ?? undefined,
			url.searchParams.get("paperId") ?? undefined,
		);
		const byPaperId: Record<string, typeof notes> = {};
		for (const note of notes) {
			for (const paper of note.papers) {
				const linkedNotes = byPaperId[paper.id] ?? [];
				linkedNotes.push(note);
				byPaperId[paper.id] = linkedNotes;
			}
		}
		json(response, 200, { notes, ...(url.pathname.endsWith("note-index") ? { byPaperId } : {}) });
		return true;
	}
	if (request.method === "POST" && url.pathname === "/api/research/notes/sync") {
		await readJson(request);

		json(response, 200, { result: await application.syncResearchNotes() });
		return true;
	}
	const noteId = noteIdFromPath(url.pathname);
	const folderId = folderIdFromPath(url.pathname);
	if (request.method === "PATCH" && folderId) {
		const body = await readJson(request);
		if (typeof body.name !== "string") throw new ApiError(400, "name is required");
		json(response, 200, {
			folder: await application.updateResearchNoteFolder(folderId, {
				name: body.name,
				...(body.parentId === null || typeof body.parentId === "string" ? { parentId: body.parentId } : {}),
			}),
		});
		return true;
	}
	if (request.method === "GET" && noteId) {
		const note = await application.getResearchNote(noteId);
		if (!note) throw new ApiError(404, `Research note not found: ${noteId}`);
		json(response, 200, { note });
		return true;
	}
	if (request.method === "PATCH" && noteId) {
		const body = await readJson(request);
		try {
			if (url.pathname.endsWith("/papers")) {
				if (!Array.isArray(body.paperIds) || !Number.isInteger(body.expectedRevision)) {
					throw new ApiError(400, "paperIds and expectedRevision are required");
				}
				const note = await application.setResearchNotePapers(
					noteId,
					body.paperIds.filter((value): value is string => typeof value === "string"),
					Number(body.expectedRevision),
				);
				json(response, 200, { note });
				return true;
			}
			if (
				typeof body.title !== "string" ||
				typeof body.markdown !== "string" ||
				!Number.isInteger(body.expectedRevision) ||
				typeof body.expectedContentHash !== "string"
			) {
				throw new ApiError(400, "title, markdown, expectedRevision and expectedContentHash are required");
			}
			const input: UpdateResearchNoteInput = {
				title: body.title,
				markdown: body.markdown,
				expectedRevision: Number(body.expectedRevision),
				expectedContentHash: body.expectedContentHash,
				...(Array.isArray(body.paperIds)
					? { paperIds: body.paperIds.filter((value): value is string => typeof value === "string") }
					: {}),
				...(body.folderId === null || typeof body.folderId === "string" ? { folderId: body.folderId } : {}),
			};
			json(response, 200, { note: await application.updateResearchNote(noteId, input) });
			return true;
		} catch (error) {
			conflictAware(error);
		}
	}
	if (request.method !== "POST") return false;
	const body = await readJson(request);

	if (url.pathname === "/api/research/notes/create/prepare") {
		json(response, 200, await application.prepareResearchNoteCreate(creationInput(body)));
		return true;
	}
	if (url.pathname === "/api/research/folders/create/prepare") {
		if (typeof body.name !== "string") throw new ApiError(400, "name is required");
		json(
			response,
			200,
			await application.prepareResearchNoteFolderCreate({
				name: body.name,
				...(typeof body.parentId === "string" ? { parentId: body.parentId } : {}),
			}),
		);
		return true;
	}
	if (url.pathname === "/api/research/folders/create/execute") {
		if (typeof body.name !== "string") throw new ApiError(400, "name is required");
		json(response, 200, {
			folder: await application.createResearchNoteFolder(
				{ name: body.name, ...(typeof body.parentId === "string" ? { parentId: body.parentId } : {}) },
				grantFromBody(body),
			),
		});
		return true;
	}
	if (url.pathname === "/api/research/folders/delete/prepare") {
		if (typeof body.folderId !== "string") throw new ApiError(400, "folderId is required");
		json(response, 200, await application.prepareResearchNoteFolderDelete(body.folderId));
		return true;
	}
	if (url.pathname === "/api/research/folders/delete/execute") {
		if (typeof body.folderId !== "string") throw new ApiError(400, "folderId is required");
		json(response, 200, {
			folder: await application.deleteResearchNoteFolder(body.folderId, grantFromBody(body)),
		});
		return true;
	}
	if (url.pathname === "/api/research/notes/create/execute") {
		json(response, 200, {
			note: await application.createResearchNote(creationInput(body), grantFromBody(body)),
		});
		return true;
	}
	if (url.pathname === "/api/research/notes/delete/prepare") {
		if (typeof body.noteId !== "string") throw new ApiError(400, "noteId is required");
		json(
			response,
			200,
			await application.prepareResearchNoteDelete(
				body.noteId,
				typeof body.author === "string" ? body.author : undefined,
			),
		);
		return true;
	}
	if (url.pathname === "/api/research/notes/delete/execute") {
		if (typeof body.noteId !== "string") throw new ApiError(400, "noteId is required");
		json(response, 200, {
			note: await application.deleteResearchNote(
				body.noteId,
				grantFromBody(body),
				typeof body.author === "string" ? body.author : undefined,
			),
		});
		return true;
	}
	if (url.pathname === "/api/research/templates/open") {
		json(response, 200, await application.openResearchTemplateDirectory());
		return true;
	}
	return false;
}
