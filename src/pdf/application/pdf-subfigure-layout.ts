import type { PaperAsset } from "../domain/pdf-types.ts";

export function attachSubfigureRegions(assets: PaperAsset[]): void {
	for (const asset of assets) {
		if (asset.type !== "figure") continue;
		const labels = new Set<string>();
		for (const match of asset.caption.matchAll(/\(([a-h])\)/gi)) labels.add(match[1].toLowerCase());
		if (labels.size < 2) {
			for (const match of asset.caption.matchAll(/\b\d+([a-h])\b/gi)) labels.add(match[1].toLowerCase());
		}
		if (labels.size < 2 && /\bleft\b/i.test(asset.caption) && /\bright\b/i.test(asset.caption)) {
			labels.add("left");
			labels.add("right");
		}
		if (labels.size < 2 || labels.size > 9) continue;
		const parent = asset.candidateRegion;
		const captionBelow = asset.captionBox.y >= parent.y + parent.height * 0.5;
		const contentTop = captionBelow ? parent.y : asset.captionBox.y + asset.captionBox.height;
		const contentBottom = captionBelow ? asset.captionBox.y : parent.y + parent.height;
		if (contentBottom - contentTop < parent.height * 0.25) continue;
		const ordered = [...labels].sort((left, right) => {
			const explicitOrder = ["left", "right"];
			const leftIndex = explicitOrder.indexOf(left);
			const rightIndex = explicitOrder.indexOf(right);
			if (leftIndex >= 0 || rightIndex >= 0) {
				return (
					(leftIndex < 0 ? explicitOrder.length : leftIndex) - (rightIndex < 0 ? explicitOrder.length : rightIndex)
				);
			}
			return left.localeCompare(right);
		});
		const columns = ordered.length === 4 ? 4 : ordered.length <= 3 ? ordered.length : ordered.length <= 6 ? 3 : 4;
		const rows = Math.ceil(ordered.length / columns);
		const cellWidth = parent.width / columns;
		const cellHeight = (contentBottom - contentTop) / rows;
		asset.subfigureRegions = ordered.map((label, index) => ({
			label,
			region: {
				x: parent.x + (index % columns) * cellWidth,
				y: contentTop + Math.floor(index / columns) * cellHeight,
				width: cellWidth,
				height: cellHeight,
			},
			confidence: ordered.length <= 3 ? "medium" : "low",
		}));
	}
}
