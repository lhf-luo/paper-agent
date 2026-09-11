import type { ZoteroApiItem } from "../domain/zotero-types.ts";

export function newestPdfAttachments(children: ZoteroApiItem[]): ZoteroApiItem[] {
	return children
		.filter(
			(child) =>
				child.data.itemType === "attachment" && /pdf/i.test(child.data.contentType ?? child.data.filename ?? ""),
		)
		.sort((left, right) => {
			const leftSupplement = /supplement/i.test(`${left.data.title ?? ""} ${left.data.filename ?? ""}`);
			const rightSupplement = /supplement/i.test(`${right.data.title ?? ""} ${right.data.filename ?? ""}`);
			return (
				Number(leftSupplement) - Number(rightSupplement) ||
				(right.data.dateModified ?? "").localeCompare(left.data.dateModified ?? "")
			);
		});
}
