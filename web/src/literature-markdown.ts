export interface ParsedCell {
	text: string;
	url?: string;
}

export interface ParsedLiteratureTable {
	focus: string;
	headers: string[];
	rows: ParsedCell[][];
}

export interface ParsedLiteratureTables {
	before: string;
	tables: ParsedLiteratureTable[];
}

const LINK_CELL = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;

function parseCell(raw: string): ParsedCell {
	const trimmed = raw.trim();
	const match = LINK_CELL.exec(trimmed);
	if (match) return { text: match[1], url: match[2] };
	return { text: trimmed };
}

/** 解析 markdown 分组表格(###/## 标题 + | 表格 |), 支持 [文本](链接) 单元格。 */
export function parseLiteratureTables(markdown: string): ParsedLiteratureTables | null {
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
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
			const isSeparator = cells.every((cell) => /^:?-{2,}:?$/.test(cell));
			if (!table) {
				table = { focus: currentFocus, headers: cells, rows: [] };
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
	return { before: kept.join("\n"), tables };
}
