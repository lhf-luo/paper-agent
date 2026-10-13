export interface Pdf2zhProgress {
	progress: number;
	message: string;
}

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const COUNTER = /\b(\d+)\s*\/\s*(\d+)\b/g;

function lastCounter(line: string): { completed: number; total: number } | undefined {
	const withoutTaskCounts = line.replace(/\(\d+\s*\/\s*\d+\)/g, "");
	let counter: { completed: number; total: number } | undefined;
	for (const match of withoutTaskCounts.matchAll(COUNTER)) {
		const completed = Number(match[1]);
		const total = Number(match[2]);
		if (total > 0 && completed <= total) counter = { completed, total };
	}
	return counter;
}

export class Pdf2zhProgressParser {
	private pending = "";
	private progress = 0.08;
	private message = "正在启动 PDF2zh Next";
	private paragraphCount?: { completed: number; total: number };
	private readonly report: (update: Pdf2zhProgress) => void;

	constructor(report: (update: Pdf2zhProgress) => void) {
		this.report = report;
	}

	feed(chunk: string): void {
		this.pending += chunk;
		const parts = this.pending.split(/[\r\n]+/);
		this.pending = parts.pop()?.slice(-4096) ?? "";
		for (const part of parts) this.process(part);
		this.process(this.pending);
	}

	private process(line: string): void {
		const value = line.replace(ANSI_ESCAPE, "").trim();
		if (!value) return;
		const isParagraphs = /Translate Paragraphs/i.test(value);
		const isOverall = /^translate\b/i.test(value) && !isParagraphs;
		const counter = lastCounter(value);
		if (isParagraphs && counter) this.paragraphCount = counter;
		if (counter && (isOverall || isParagraphs)) {
			const next = Math.min(0.88, 0.08 + 0.8 * (counter.completed / counter.total));
			const count = this.paragraphCount;
			const message = count
				? `正在翻译段落 ${count.completed}/${count.total}`
				: `正在翻译 PDF ${Math.round((counter.completed / counter.total) * 100)}%`;
			this.emit(next, message);
			return;
		}
		if (isParagraphs) {
			this.emit(this.progress, "正在翻译段落");
		} else if (/Parse PDF|Parse Page Layout|DetectScannedFile|Parse Paragraphs|Parse Formulas/i.test(value)) {
			this.emit(this.progress, "正在解析 PDF");
		}
	}

	private emit(progress: number, message: string): void {
		const next = Math.max(this.progress, progress);
		if (next === this.progress && message === this.message) return;
		this.progress = next;
		this.message = message;
		this.report({ progress: next, message });
	}
}
