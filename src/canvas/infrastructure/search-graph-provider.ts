import type { PaperRecord } from "../../literature/domain/literature-types.ts";
import { providerCredentials, LiteratureProviderHttpError } from "../../literature/infrastructure/provider-common.ts";
import { fetchWithTimeout, type Fetcher } from "../../shared/infrastructure/network-security.ts";
import { evidenceId, type CitationSet } from "../domain/search-graph-relations.ts";
export function graphProvider(paper: PaperRecord) {
	const oa = paper.identifiers.openAlexId?.split("/").at(-1);
	const s2 =
		paper.identifiers.semanticScholarId ??
		(paper.identifiers.doi
			? `DOI:${paper.identifiers.doi}`
			: paper.identifiers.arxivId
				? `ARXIV:${paper.identifiers.arxivId}`
				: undefined);
	return { provider: oa ? "openalex" : "semanticscholar", id: oa ?? s2 };
}
function pageRequest(provider: string, id: string | undefined, channel: "references" | "citations", set: CitationSet) {
	if (!id) throw new Error("缺少可解析的 DOI、arXiv 或提供商 ID");
	const headers: Record<string, string> = {};
	let url: URL;
	if (provider === "openalex") {
		url = new URL(
			channel === "references"
				? `https://api.openalex.org/works/${encodeURIComponent(id)}`
				: "https://api.openalex.org/works",
		);
		if (channel === "citations") {
			url.searchParams.set("filter", `cites:${id}`);
			url.searchParams.set("per-page", "200");
			url.searchParams.set("cursor", set.cursor ?? "*");
			url.searchParams.set("select", "id");
		} else url.searchParams.set("select", "id,referenced_works");
		if (providerCredentials.openAlexMailto) url.searchParams.set("mailto", providerCredentials.openAlexMailto);
		if (process.env.OPENALEX_API_KEY) url.searchParams.set("api_key", process.env.OPENALEX_API_KEY);
	} else {
		url = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}/${channel}`);
		url.searchParams.set("fields", "paperId");
		url.searchParams.set("limit", "100");
		url.searchParams.set("offset", set.cursor ?? "0");
		if (providerCredentials.semanticScholarApiKey) headers["x-api-key"] = providerCredentials.semanticScholarApiKey;
	}

	return { url, headers };
}
/** Exactly one HTTP attempt; the job owns retries, pacing and its persisted request budget. */
export async function fetchGraphCitationPage(
	paper: PaperRecord,
	channel: "references" | "citations",
	set: CitationSet,
	signal: AbortSignal,
	fetcher?: Fetcher,
) {
	const { provider, id } = graphProvider(paper);
	const { url, headers } = pageRequest(provider, id, channel, set);
	const response = await fetchWithTimeout(url, signal, 20_000, { headers }, fetcher);
	if (!response.ok) throw new LiteratureProviderHttpError(provider, response);
	const data = (await response.json()) as {
		referenced_works?: string[];
		results?: { id: string }[];
		meta?: { next_cursor?: string };
		data?: { citingPaper?: { paperId?: string }; citedPaper?: { paperId?: string } }[];
		next?: number;
	};
	if (provider === "openalex") {
		const ids = channel === "references" ? data.referenced_works : data.results?.map((p) => p.id);
		if (!Array.isArray(ids)) throw new Error("OpenAlex 返回的引文集合格式无效");
		return {
			provider,
			ids: ids.map(evidenceId),
			cursor: channel === "citations" && ids.length ? data.meta?.next_cursor : undefined,
		};
	}
	if (!Array.isArray(data.data)) throw new Error("Semantic Scholar 返回的引文集合格式无效");
	return {
		provider,
		ids: data.data.flatMap((item) => {
			const key = (channel === "references" ? item.citedPaper : item.citingPaper)?.paperId;
			return key ? [evidenceId(key)] : [];
		}),
		cursor: data.next === undefined ? undefined : String(data.next),
	};
}
