import type { PaperAsset } from "../domain/pdf-types.ts";

export function normalizedCaptionMatch(text: string): { type: PaperAsset["type"]; identifier: string } | undefined {
	const chinese = /^\s*(图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)\s*[：:.]?/.exec(text);
	if (chinese) return { type: chinese[1] === "表" ? "table" : "figure", identifier: chinese[2] };
	if (/^\s*(?:table|algorithm|listing)\.\d+\s*$/.test(text)) return undefined;
	const match =
		/^\s*(fig(?:ure)?|table|algorithm|listing)\.?\s*(?:\(|\[)?([A-Z]?\d+(?:[.-]\d+)*|[IVXLCDM]+)(?:\)|\])?\s*([.:|])?(?:\s|$)/i.exec(
			text,
		);
	if (!match) return undefined;
	const label = match[1].toLowerCase();
	if (!match[3] && label !== "algorithm" && label !== "listing") {
		const trailing = text.slice(match[0].length).trim();
		if (trailing && !(match[1] === match[1].toUpperCase() && trailing === trailing.toUpperCase())) {
			return undefined;
		}
	}
	const type =
		label === "table" ? "table" : label === "algorithm" ? "algorithm" : label === "listing" ? "listing" : "figure";
	return { type, identifier: match[2] };
}
