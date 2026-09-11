import type { PaperRecord } from "./types.ts";

function normalizeDoi(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "")
		.replace(/[)\],.;]+$/g, "")
		.toLowerCase();
	return /^10\.\d{4,9}\/\S+$/.test(normalized) ? normalized : undefined;
}

export function paperPrimaryUrl(paper: PaperRecord): string | undefined {
	const doi = normalizeDoi(paper.identifiers.doi);
	if (doi) return `https://doi.org/${doi}`;
	const doiLink = paper.links.find((link) => link.kind === "doi")?.url;
	if (doiLink) return doiLink;
	if (paper.identifiers.arxivId) return `https://arxiv.org/abs/${paper.identifiers.arxivId.replace(/v\d+$/i, "")}`;
	return (
		paper.links.find((link) => link.kind === "landing")?.url ??
		paper.links.find((link) => link.kind === "pdf")?.url ??
		paper.links[0]?.url
	);
}

export function paperPrimaryAction(paper: PaperRecord): { url: string; label: string } | undefined {
	const url = paperPrimaryUrl(paper);
	if (!url) return undefined;
	if (normalizeDoi(paper.identifiers.doi) || paper.links.some((link) => link.kind === "doi" && link.url === url)) {
		return { url, label: "打开 DOI" };
	}
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		if (hostname === "arxiv.org" || hostname.endsWith(".arxiv.org")) {
			return { url, label: "打开 arXiv" };
		}
	} catch {
		// Stored links are validated elsewhere; fall back to the generic label for legacy records.
	}
	return { url, label: "打开论文页" };
}

export function paperLinksForDisplay(paper: PaperRecord): PaperRecord["links"] {
	const doi = normalizeDoi(paper.identifiers.doi);
	const doiUrl = doi ? `https://doi.org/${doi}` : undefined;
	const links = doiUrl
		? [{ url: doiUrl, kind: "doi" }, ...paper.links.filter((link) => normalizeDoi(link.url) !== doi)]
		: [...paper.links];
	const priority: Record<string, number> = { doi: 0, landing: 1, pdf: 2, artifact: 3, other: 4 };
	return links.sort((left, right) => (priority[left.kind] ?? 5) - (priority[right.kind] ?? 5));
}
