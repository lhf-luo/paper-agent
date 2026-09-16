export interface ParsedCell {
	text: string;
	url?: string;
}

export interface ParsedLiteratureTable {
	focus: string;
	headers: string[];
	rows: ParsedCell[][];
	/** 自定义列标题(工具传入), 覆盖表格首行表头。 */
	customHeaders?: string[];
	/** 与表格行对齐的结构化元信息(paper_id/doi/abstract/search_run_id)。 */
	rowMeta?: Array<Record<string, unknown>>;
}

export interface ParsedLiteratureTables {
	before: string;
	tables: ParsedLiteratureTable[];
	/** 整个文档的元信息(自定义表头 + 行元信息)。 */
	meta?: { headers?: string[]; rows?: Array<Record<string, unknown>> };
}

const LINK_CELL = /^\[((?:\\.|[^\]])+)\]\((https?:\/\/[^)\s]+)\)$/;
const SIDEBAR_META_COMMENT = /<!--\s*paper-agent-sidebar-meta\s+([\s\S]*?)\s*-->\s*$/;

function tryParseSidebarMeta(markdown: string): { headers?: string[]; rows?: Array<Record<string, unknown>> } | null {
	const match = SIDEBAR_META_COMMENT.exec(markdown.trim());
	if (!match) return null;
	try {
		const value = JSON.parse(match[1]) as { headers?: string[]; rows?: Array<Record<string, unknown>> };
		if (value && typeof value === "object") return value;
	} catch {
		// ignore malformed metadata
	}
	return null;
}

function parseCell(raw: string): ParsedCell {
	const trimmed = raw.trim();
	const match = LINK_CELL.exec(trimmed);
	if (match) return { text: match[1].replace(/\\([[\]|])/g, "$1"), url: match[2] };
	return { text: trimmed.replaceAll("\\|", "|") };
}

/** 解析 markdown 分组表格(###/## 标题 + | 表格 |), 支持 [文本](链接) 单元格。 */
export function parseLiteratureTables(markdown: string): ParsedLiteratureTables | null {
	const meta = tryParseSidebarMeta(markdown);
	const lines = markdown.split(/\r?\n/);
	const tables: ParsedLiteratureTable[] = [];
	const kept: string[] = [];
	let currentFocus = "";
	let table: ParsedLiteratureTable | undefined;
	const flush = () => {
		if (table && table.rows.length > 0) {
			tables.push(table);
		}
		table = undefined;
	};
	for (const raw of lines) {
		const line = raw.trim();
		const heading = /^#{1,6}\s+(.+)$/.exec(line);
		const cellRow = line.startsWith("|") && line.endsWith("|") && line.split("|").length >= 3;
		if (heading) {
			flush();
			currentFocus = heading[1].trim();
			kept.push(raw);
			continue;
		}
		if (cellRow) {
			const cells = line
				.split(/(?<!\\)\|/)
				.slice(1, -1)
				.map((cell) => cell.trim());
			const isSeparator = cells.every((cell) => /^:?-{2,}:?$/.test(cell));
			if (!table) {
				table = {
					focus: currentFocus,
					headers: cells,
					rows: [],
					customHeaders: meta?.headers,
					rowMeta: meta?.rows,
				};
			} else if (isSeparator) {
				// 表头分隔行, 跳过
			} else {
				table.rows.push(cells.map(parseCell));
			}
			continue;
		}
		flush();
		kept.push(raw);
	}
	flush();
	if (tables.length === 0) return null;
	return { before: kept.join("\n"), tables, meta: meta ?? undefined };
}
