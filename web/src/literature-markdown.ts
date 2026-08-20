export interface ParsedLiteratureTable {
	focus: string;
	headers: string[];
	rows: string[][];
}

export interface ParsedLiteratureTables {
	before: string;
	tables: ParsedLiteratureTable[];
}

/** 解析 agent 消息中的 Markdown 分组表格(### 标题 + | 表格 |), 返回分组结构与剩余文本。 */
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
				table.rows.push(cells);
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
