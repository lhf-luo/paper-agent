import type { PaperAsset } from "../domain/pdf-types.ts";
import { intersects, type PdfLayoutPage } from "./pdf-layout.ts";
import { sectionHeading } from "./pdf-section-heading.ts";

function referenceOrdinal(identifier: string): { prefix: string; value: number } | undefined {
	const numeric = /^(.*?)(\d+)$/.exec(identifier);
	if (numeric) return { prefix: numeric[1], value: Number(numeric[2]) };
	if (!/^[ivxlcdm]+$/.test(identifier)) return undefined;
	const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
	const digits = [...identifier].map((digit) => values[digit]);
	return {
		prefix: "roman",
		value: digits.reduce((sum, value, index) => sum + (value < (digits[index + 1] ?? 0) ? -value : value), 0),
	};
}

function identifiersInRange(start: string, end: string, known: string[]): string[] {
	const first = referenceOrdinal(start);
	const last = referenceOrdinal(end);
	if (!first || !last || first.prefix !== last.prefix || first.value > last.value) return [start, end];
	// Select existing objects instead of expanding an unbounded numeric range from PDF text.
	return known.filter((identifier) => {
		const ordinal = referenceOrdinal(identifier);
		return ordinal && ordinal.prefix === first.prefix && ordinal.value >= first.value && ordinal.value <= last.value;
	});
}

function referenceTerm(text: string, known: string[]): { identifiers: string[]; length: number } | undefined {
	const identifier = /^([A-Za-z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)(?:\s*\([a-z]\)|[a-z])?(?![\p{L}\p{N}_]|\s*%)/u;
	const first = identifier.exec(text);
	if (!first) return undefined;
	const start = first[1].toLowerCase();
	const range = /^\s*(?:[-–—]|to\b)\s*/i.exec(text.slice(first[0].length));
	if (range) {
		const last = identifier.exec(text.slice(first[0].length + range[0].length));
		if (last) {
			return {
				identifiers: identifiersInRange(start, last[1].toLowerCase(), known),
				length: first[0].length + range[0].length + last[0].length,
			};
		}
	}
	const compactRange = /^([a-z]?\d+(?:\.\d+)*)-([a-z]?\d+(?:\.\d+)*)$/.exec(start);
	return {
		identifiers:
			compactRange && !known.includes(start) ? identifiersInRange(compactRange[1], compactRange[2], known) : [start],
		length: first[0].length,
	};
}

function referenceIdentifiers(
	text: string,
	assets: PaperAsset[],
): Array<{ type: PaperAsset["type"]; identifiers: string[]; matchedText: string }> {
	const references: Array<{ type: PaperAsset["type"]; identifiers: string[]; matchedText: string }> = [];
	const pattern = /\b(fig(?:ure)?s?|tables?|algorithms?|listings?)\.?\s+/gi;
	for (const match of text.matchAll(pattern)) {
		const label = match[1].toLowerCase();
		const type: PaperAsset["type"] = label.startsWith("tab")
			? "table"
			: label.startsWith("alg")
				? "algorithm"
				: label.startsWith("list")
					? "listing"
					: "figure";
		const known = assets.filter((asset) => asset.type === type).map((asset) => asset.identifier.toLowerCase());
		const suffix = text.slice(match.index + match[0].length);
		const first = referenceTerm(suffix, known);
		if (!first) continue;
		const identifiers = [...first.identifiers];
		let length = first.length;
		while (length < suffix.length) {
			const separator = /^\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+|&\s*)/i.exec(suffix.slice(length));
			if (!separator) break;
			const next = referenceTerm(suffix.slice(length + separator[0].length), known);
			if (!next) break;
			identifiers.push(...next.identifiers);
			length += separator[0].length + next.length;
		}
		references.push({
			type,
			identifiers: [...new Set(identifiers)],
			matchedText: (match[0] + suffix.slice(0, length)).trim(),
		});
	}
	for (const match of text.matchAll(/(图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)/g)) {
		references.push({
			type: match[1] === "表" ? "table" : "figure",
			identifiers: [match[2].toLowerCase()],
			matchedText: match[0],
		});
	}
	return references;
}

export function attachAssetMentions(layouts: PdfLayoutPage[], assets: PaperAsset[]): void {
	const keyCounts = new Map<string, number>();
	for (const asset of assets) {
		const key = `${asset.type}:${asset.identifier.toLowerCase()}`;
		keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
	}
	let section: string | undefined;
	for (const page of layouts) {
		const lines = [...page.lines].filter((line) => line.text.trim()).sort((left, right) => left.order - right.order);
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const block = page.blocks.find((item) => item.blockId === line.blockId);
			if (sectionHeading(line.text) && (block?.lines.length ?? 0) <= 2) {
				section = line.text.trim();
				continue;
			}
			for (const reference of referenceIdentifiers(line.text, assets)) {
				for (const identifier of reference.identifiers) {
					const candidates = assets.filter(
						(asset) => asset.type === reference.type && asset.identifier.toLowerCase() === identifier,
					);
					for (const asset of candidates) {
						if (asset.page === page.page && intersects(line, asset.captionBox)) continue;
						const context = (
							block?.text ||
							lines
								.slice(Math.max(0, index - 1), index + 2)
								.map((item) => item.text)
								.join(" ")
						)
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, 600);
						const key = `${asset.type}:${identifier}`;
						asset.mentions.push({
							page: page.page,
							matchedText: reference.matchedText,
							section,
							context,
							lineBox: { x: line.x, y: line.y, width: line.width, height: line.height },
							confidence: (keyCounts.get(key) ?? 0) === 1 ? "high" : "ambiguous",
						});
					}
				}
			}
		}
	}
}
