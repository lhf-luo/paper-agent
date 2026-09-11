import type { PaperAsset } from "../domain/pdf-types.ts";
import { intersects, type PdfLayoutPage } from "./pdf-layout.ts";
import { sectionHeading } from "./pdf-section-heading.ts";

function referenceIdentifiers(
	text: string,
): Array<{ type: PaperAsset["type"]; identifiers: string[]; matchedText: string }> {
	const references: Array<{ type: PaperAsset["type"]; identifiers: string[]; matchedText: string }> = [];
	const pattern = /\b(fig(?:ure)?s?|tables?|algorithms?|listings?)\.?\s+([^.;:\n]{1,100})/gi;
	for (const match of text.matchAll(pattern)) {
		const label = match[1].toLowerCase();
		const type: PaperAsset["type"] = label.startsWith("tab")
			? "table"
			: label.startsWith("alg")
				? "algorithm"
				: label.startsWith("list")
					? "listing"
					: "figure";
		const identifiers = [...match[2].matchAll(/\b(?:[A-Z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)\b/g)].map((identifier) =>
			identifier[0].toLowerCase(),
		);
		if (identifiers.length) references.push({ type, identifiers, matchedText: match[0].trim() });
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
			for (const reference of referenceIdentifiers(line.text)) {
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
