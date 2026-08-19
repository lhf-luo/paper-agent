import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PaperRecord } from "./literature-types.ts";
import { LiteratureStore, resolveCorpusRoot } from "./literature-store.ts";
import { fetchPublicUrl } from "./network-security.ts";

function escapeLatex(value: string): string {
	return value
		.replace(/\\/g, "\\textbackslash{}")
		.replace(/([&%$#_{}])/g, "\\$1")
		.replace(/~/g, "\\textasciitilde{}")
		.replace(/\^/g, "\\textasciicircum{}");
}

function bibtexKey(record: PaperRecord): string {
	const authors = record.authors[0] ?? "unknown";
	const surname = authors.trim().split(/\s+/).pop() ?? "unknown";
	const year = record.year ?? new Date().getFullYear();
	const firstWord = (record.title ?? "untitled").trim().split(/\s+/)[0] ?? "untitled";
	const clean = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "")
			.slice(0, 30) || "x";
	return `${clean(surname)}${year}${clean(firstWord)}`;
}

function bibtexEntryFromMetadata(record: PaperRecord): string {
	const entryType = record.publicationType === "preprint" ? "misc" : "article";
	const fields: Array<[string, string]> = [];
	fields.push(["title", `{${escapeLatex(record.title)}}`]);
	if (record.authors.length) {
		fields.push(["author", record.authors.map((author) => escapeLatex(author)).join(" and ")]);
	}
	if (record.year) fields.push(["year", String(record.year)]);
	if (record.venue) fields.push(["journal", `{${escapeLatex(record.venue)}}`]);
	if (record.identifiers.doi) fields.push(["doi", record.identifiers.doi]);
	if (record.identifiers.arxivId) fields.push(["eprint", record.identifiers.arxivId]);
	const landing = record.links.find((link) => link.kind === "landing")?.url;
	if (landing) fields.push(["url", landing]);
	const body = fields.map(([name, value]) => `  ${name} = ${value}`).join(",\n");
	return `@${entryType}{${bibtexKey(record)},\n${body}\n}`;
}

/** DOI → CrossRef 内容协商拿 BibTeX; 失败则用元数据生成 */
async function bibtexForRecord(record: PaperRecord, signal?: AbortSignal): Promise<string> {
	const doi = record.identifiers.doi;
	if (doi) {
		try {
			// 直连 CrossRef transform 端点(绕过 doi.org 重定向和反爬); Accept 必须大写以覆盖默认头
			const response = await fetchPublicUrl(
				new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}/transform`),
				{
					signal,
					timeoutMs: 15_000,
					init: { headers: { Accept: "application/x-bibtex" } },
				},
			);
			const contentType = response.response.headers.get("content-type") ?? "";
			if (response.response.ok && contentType.includes("bibtex")) {
				const text = await response.response.text();
				if (text.trim().startsWith("@")) return text.trim();
			}
		} catch {
			// 回退到元数据生成
		}
	}
	return bibtexEntryFromMetadata(record);
}

export async function exportBibtexForRecords(records: PaperRecord[], signal?: AbortSignal): Promise<string> {
	const entries = await Promise.all(records.map((record) => bibtexForRecord(record, signal)));
	return entries.join("\n\n") + "\n";
}

export function registerBibtexTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "export_bibtex",
		label: "Export BibTeX",
		description:
			"Export selected personal-corpus papers as BibTeX. Prefers CrossRef DOI content negotiation; falls back to metadata-generated entries when the DOI is missing or CrossRef is unreachable.",
		promptSnippet: "Export selected papers as BibTeX for a bibliography",
		promptGuidelines: [
			"Choose the papers from the personal corpus by paper id.",
			"Report which entries came from CrossRef and which were metadata-generated fallbacks.",
		],
		parameters: Type.Object({
			paperIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 })),
			namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const namespace = typeof params.namespace === "string" && params.namespace ? params.namespace : "default";
			const root = resolveCorpusRoot(ctx.cwd, "personal", namespace);
			const store = new LiteratureStore(root, "personal", namespace);
			await store.initialize();
			const records: PaperRecord[] = [];
			const missing: string[] = [];
			for (const paperId of params.paperIds) {
				const record = await store.getPaper(paperId);
				if (record) records.push(record);
				else missing.push(paperId);
			}
			const bibtex = await exportBibtexForRecords(records, signal);
			const details = {
				entryCount: records.length,
				missingPaperIds: missing,
				corpusPath: store.root,
				namespace,
			};
			return {
				content: [{ type: "text", text: bibtex }],
				details,
			};
		},
	});
}
