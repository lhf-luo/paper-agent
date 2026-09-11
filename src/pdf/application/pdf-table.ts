import type { PdfBox } from "../domain/pdf-types.ts";
import type { LayoutWord } from "./pdf-layout.ts";

export interface TableGrid {
	rows: string[][];
	columnAnchors: number[];
	usedExplicitBoundaries: boolean;
	warnings: string[];
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function clusterVisualRows(words: LayoutWord[]): LayoutWord[][] {
	const tolerance = Math.max(2, median(words.map((word) => word.height)) * 0.55);
	const rows: Array<{ centerY: number; words: LayoutWord[] }> = [];
	for (const word of [...words].sort((left, right) => left.y - right.y || left.x - right.x)) {
		const centerY = word.y + word.height / 2;
		let row = rows.find((candidate) => Math.abs(candidate.centerY - centerY) <= tolerance);
		if (!row) {
			row = { centerY, words: [] };
			rows.push(row);
		}
		row.words.push(word);
		row.centerY = row.words.reduce((sum, item) => sum + item.y + item.height / 2, 0) / row.words.length;
	}
	return rows
		.sort((left, right) => left.centerY - right.centerY)
		.map((row) => row.words.sort((left, right) => left.x - right.x));
}

function splitIntoChunks(words: LayoutWord[], gapThreshold: number): LayoutWord[][] {
	const chunks: LayoutWord[][] = [];
	for (const word of words) {
		const current = chunks.at(-1);
		const previous = current?.at(-1);
		if (!current || !previous || word.x - (previous.x + previous.width) > gapThreshold) chunks.push([word]);
		else current.push(word);
	}
	return chunks;
}

function inferColumnAnchors(rows: LayoutWord[][], region: PdfBox): number[] {
	const wordHeight = median(rows.flat().map((word) => word.height));
	const gapThreshold = Math.max(10, wordHeight * 1.35);
	const starts = rows.flatMap((row) => splitIntoChunks(row, gapThreshold).map((chunk) => chunk[0].x));
	const clusters: Array<{ center: number; count: number }> = [];
	for (const start of starts.sort((left, right) => left - right)) {
		const cluster = clusters.find((candidate) => Math.abs(candidate.center - start) <= Math.max(8, wordHeight));
		if (cluster) {
			cluster.center = (cluster.center * cluster.count + start) / (cluster.count + 1);
			cluster.count++;
		} else {
			clusters.push({ center: start, count: 1 });
		}
	}
	const minimumSupport = Math.max(2, Math.ceil(rows.length * 0.5));
	const supported = clusters
		.filter(
			(cluster) =>
				cluster.count >= minimumSupport && cluster.center >= region.x && cluster.center <= region.x + region.width,
		)
		.sort((left, right) => left.center - right.center)
		.slice(0, 12)
		.map((cluster) => cluster.center);
	return supported.length > 0 ? supported : [region.x];
}

function escapeMarkdownCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function csvCell(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function buildTableGrid(words: LayoutWord[], region: PdfBox, explicitBoundaries?: number[]): TableGrid {
	const visualRows = clusterVisualRows(words);
	const warnings = [
		"Rows are reconstructed from visual baselines; wrapped or merged cells may appear as additional rows.",
		"Markdown serialization treats the first extracted visual row as a header; verify multi-row headers in the image.",
	];
	if (visualRows.length === 0) {
		return {
			rows: [],
			columnAnchors: [],
			usedExplicitBoundaries: explicitBoundaries !== undefined,
			warnings: ["No text-layer words were found in the region; inspect the returned image or use OCR externally."],
		};
	}

	if (explicitBoundaries) {
		const boundaries = [...explicitBoundaries].sort((left, right) => left - right);
		if (boundaries.some((boundary, index) => index > 0 && boundary - boundaries[index - 1] < 0.5)) {
			throw new Error("column_boundaries must be unique and separated by at least 0.5 PDF points.");
		}
		const rows = visualRows.map((row) => {
			const cells = Array.from({ length: boundaries.length + 1 }, () => [] as string[]);
			for (const word of row) {
				const center = word.x + word.width / 2;
				const column = boundaries.findIndex((boundary) => center < boundary);
				cells[column === -1 ? cells.length - 1 : column].push(word.text);
			}
			return cells.map((cell) => cell.join(" "));
		});
		return {
			rows,
			columnAnchors: [region.x, ...boundaries],
			usedExplicitBoundaries: true,
			warnings,
		};
	}

	const anchors = inferColumnAnchors(visualRows, region);
	const gapThreshold = Math.max(10, median(words.map((word) => word.height)) * 1.35);
	const rows = visualRows.map((row) => {
		const cells = Array.from({ length: anchors.length }, () => [] as string[]);
		for (const chunk of splitIntoChunks(row, gapThreshold)) {
			const chunkStart = chunk[0].x;
			let column = 0;
			let distance = Number.POSITIVE_INFINITY;
			for (let index = 0; index < anchors.length; index++) {
				const candidateDistance = Math.abs(anchors[index] - chunkStart);
				if (candidateDistance < distance) {
					distance = candidateDistance;
					column = index;
				}
			}
			cells[column].push(chunk.map((word) => word.text).join(" "));
		}
		return cells.map((cell) => cell.join(" "));
	});
	if (anchors.length < 2) {
		warnings.push(
			"Automatic column detection found fewer than two stable column anchors; provide column_boundaries.",
		);
	} else {
		warnings.push(
			"Column anchors were inferred heuristically; verify the image and retry with column_boundaries if needed.",
		);
	}
	return { rows, columnAnchors: anchors, usedExplicitBoundaries: false, warnings };
}

export function markdownTable(rows: string[][]): string {
	if (rows.length === 0) return "(no structured rows extracted)";
	const columnCount = Math.max(...rows.map((row) => row.length));
	const normalized = rows.map((row) => Array.from({ length: columnCount }, (_value, index) => row[index] ?? ""));
	return [
		`| ${normalized[0].map(escapeMarkdownCell).join(" | ")} |`,
		`| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`,
		...normalized.slice(1).map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
	].join("\n");
}

export function csvTable(rows: string[][]): string {
	return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}
