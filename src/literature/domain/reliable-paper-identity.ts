import type { PaperRecord } from "./literature-types.ts";
/** Identity matching deliberately excludes title and author names. */
export function paperIdentityKeys(paper: PaperRecord): string[] {
	const providerFields: Record<string, string> = {
		openalex: "openAlexId",
		semanticscholar: "semanticScholarId",
		arxiv: "arxivId",
		dblp: "dblpKey",
	};
	const providerKeys = paper.provenance.flatMap((p) =>
		p.providerRecordId
			? [
					[`provider:${p.provider}`, p.providerRecordId],
					...(providerFields[p.provider] ? [[providerFields[p.provider], p.providerRecordId]] : []),
				]
			: [],
	);
	return [...Object.entries(paper.identifiers), ...providerKeys]
		.filter(([, value]) => value)
		.map(([kind, value]) => {
			let normalized = String(value).trim().toLowerCase();
			if (kind === "doi") normalized = normalized.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
			if (kind === "arxivId")
				normalized = normalized.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, "").replace(/v\d+$/, "");
			if (kind === "openAlexId") normalized = normalized.replace(/^https?:\/\/openalex\.org\//, "");
			return `${kind}:${normalized}`;
		});
}
export function samePaper(left: PaperRecord, right: PaperRecord): boolean {
	const keys = new Set(paperIdentityKeys(left));
	return (
		paperIdentityKeys(right).some((key) => keys.has(key)) ||
		left.id === right.id ||
		left.mergedFrom.includes(right.id) ||
		right.mergedFrom.includes(left.id)
	);
}
