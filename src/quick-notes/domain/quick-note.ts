export interface QuickNotePaper {
	id: string;
	title: string;
	authors: string[];
	year?: number;
}

export interface QuickNoteLocator {
	pdfSha256: string;
	pages: number[];
	versionLabel?: string;
}

export interface QuickNote {
	id: string;
	content: string;
	paper: QuickNotePaper;
	sourceSnapshot: QuickNotePaper;
	paperAvailable: boolean;
	locator?: QuickNoteLocator;
	locationAvailable: boolean;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface CreateQuickNoteInput {
	clientRequestId: string;
	content: string;
	paperId: string;
	locator?: QuickNoteLocator;
}

export interface QuickNoteQuery {
	query?: string;
	paperId?: string;
	page?: number;
	pageSize?: number;
}

export interface QuickNoteList {
	notes: QuickNote[];
	total: number;
	page: number;
	pageSize: number;
	sources: Array<QuickNotePaper & { available: boolean }>;
}

export class QuickNoteError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface QuickNoteRepository {
	get(id: string): Promise<QuickNote>;
	list(query: Required<QuickNoteQuery>): Promise<QuickNoteList>;
	create(input: CreateQuickNoteInput): Promise<QuickNote>;
	update(id: string, content: string, expectedRevision: number): Promise<QuickNote>;
	delete(id: string): Promise<void>;
	countForPapers(paperIds: string[]): Promise<number>;
}
