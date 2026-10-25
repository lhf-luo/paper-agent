import type { LiteratureProvider, PaperRecord, ProviderFailure } from "../domain/literature-types.ts";
import {
	fetchOpenAlexWorks,
	searchOpenAlexCitations,
	searchSemanticScholarCitations,
} from "../infrastructure/literature-providers.ts";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import { collectCitationPages } from "./literature-search-planning.ts";

/** Each provider gets its own failure boundary, including a successful zero-result response. */
export async function citationNeighbors(input: {
	seed: PaperRecord;
	direction: "references" | "citations";
	pages: number;
	remaining: () => number;
	signal?: AbortSignal;
	attempted: Set<LiteratureProvider>;
	failures: ProviderFailure[];
	accept: (papers: PaperRecord[], relationship: "reference" | "citation", provider: LiteratureProvider) => void;
}) {
	const { seed, direction, signal } = input;
	const query = `${direction}:${seed.id}`;
	const attempt = async (provider: LiteratureProvider, queryPapers: () => Promise<PaperRecord[]>) => {
		if (input.remaining() <= 0) return;
		signal?.throwIfAborted();
		input.attempted.add(provider);
		try {
			input.accept(await queryPapers(), direction === "references" ? "reference" : "citation", provider);
		} catch (error) {
			signal?.throwIfAborted();
			input.failures.push({ provider, query, message: readableErrorMessage(error), retryable: true });
		}
	};
	if (direction === "references" && seed.referencedWorks?.length) {
		await attempt("openalex", () =>
			fetchOpenAlexWorks(seed.referencedWorks!.slice(0, input.remaining()), { signal, queryLabel: query }),
		);
	}
	if (direction === "citations" && seed.identifiers.openAlexId) {
		await attempt("openalex", () =>
			collectCitationPages(
				(limit, cursor) =>
					searchOpenAlexCitations(seed.identifiers.openAlexId!, { limit, cursor, signal, queryLabel: query }),
				input.remaining(),
				input.pages,
			),
		);
	}
	// DOI/arXiv aliases also work with Semantic Scholar; an OpenAlex enrichment must not hide this source.
	const scholarId =
		seed.identifiers.semanticScholarId ??
		(seed.identifiers.doi
			? `DOI:${seed.identifiers.doi}`
			: seed.identifiers.arxivId
				? `ARXIV:${seed.identifiers.arxivId}`
				: undefined);
	if (scholarId)
		await attempt("semanticscholar", () =>
			collectCitationPages(
				(limit, cursor) =>
					searchSemanticScholarCitations(scholarId, direction, { limit, cursor, signal, queryLabel: query }),
				input.remaining(),
				input.pages,
			),
		);
}
