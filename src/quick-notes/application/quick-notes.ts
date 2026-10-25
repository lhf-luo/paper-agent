import {
	type CreateQuickNoteInput,
	QuickNoteError,
	type QuickNoteQuery,
	type QuickNoteRepository,
} from "../domain/quick-note.ts";

function nonempty(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new QuickNoteError(400, `${label}不能为空，且最多 ${max} 个字符`);
	}
	return value.trim();
}

export class QuickNotes {
	private readonly repository: QuickNoteRepository;
	constructor(repository: QuickNoteRepository) {
		this.repository = repository;
	}

	async list(query: QuickNoteQuery = {}) {
		const page = query.page ?? 1;
		const pageSize = query.pageSize ?? 30;
		if (
			!Number.isSafeInteger(page) ||
			page < 1 ||
			page > 1_000_000 ||
			!Number.isSafeInteger(pageSize) ||
			pageSize < 1 ||
			pageSize > 100
		) {
			throw new QuickNoteError(400, "分页参数无效");
		}
		return this.repository.list({
			query: query.query ? nonempty(query.query, "搜索词", 500) : "",
			paperId: query.paperId ? nonempty(query.paperId, "论文 ID", 500) : "",
			page,
			pageSize,
		});
	}

	async create(input: CreateQuickNoteInput) {
		const normalized: CreateQuickNoteInput = {
			content: nonempty(input.content, "记录内容", 50_000),
			paperId: nonempty(input.paperId, "论文 ID", 500),
			clientRequestId: nonempty(input.clientRequestId, "请求 ID", 100),
		};
		if (input.locator !== undefined) {
			const locator = input.locator;
			if (
				!locator ||
				typeof locator !== "object" ||
				typeof locator.pdfSha256 !== "string" ||
				!/^[a-f0-9]{64}$/i.test(locator.pdfSha256) ||
				!Array.isArray(locator.pages) ||
				!locator.pages.length ||
				locator.pages.length > 500 ||
				locator.pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > 100_000)
			) {
				throw new QuickNoteError(400, "PDF 定位信息无效");
			}
			normalized.locator = {
				pdfSha256: locator.pdfSha256.toLowerCase(),
				pages: [...new Set(locator.pages)].sort((a, b) => a - b),
			};
		}
		return this.repository.create(normalized);
	}

	async update(id: string, content: string, expectedRevision: number) {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
			throw new QuickNoteError(400, "记录修订版本无效");
		}
		return this.repository.update(id, nonempty(content, "记录内容", 50_000), expectedRevision);
	}

	delete(id: string) {
		return this.repository.delete(id);
	}
	get(id: string) {
		return this.repository.get(id);
	}
	countForPapers(paperIds: string[]) {
		return this.repository.countForPapers(paperIds);
	}
}
