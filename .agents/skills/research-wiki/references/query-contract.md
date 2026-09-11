# Research Wiki query contract

Query answers only what has been explicitly deposited into the Wiki.

## Sequence

1. Call `search_research_wiki` with the user’s concepts, known aliases, paper id, or note id.
2. Read complete pages by `page_id`; snippets are only navigation.
3. If needed, request one-hop related pages and read only those that can affect the answer.
4. Preserve Wiki page IDs and evidence IDs in the answer.
5. When the Wiki has no supporting knowledge, say it has not been deposited. Suggest paper research or an explicit ingest instead.

## Answer boundaries

- Do not silently use a PDF, MinerU package, personal note, provider result, or model memory to fill a Wiki gap.
- Do not claim that a Wiki page is a human-reviewed conclusion unless its status is `reviewed`.
- Treat `draft`, `needs-review`, and `conflicted` pages as explicit quality signals.
- A related page is a navigation hint; it does not inherit the evidence of the starting page.
- For a scientific claim, include the original paper/note/Artifact locator saved in the page. If the user asks for fresh verification, run the paper-research workflow against the primary source.

## Retrieval behavior

Search combines exact title/alias matching, page-level metadata, body chunks, source filters, and one-hop links. If a query has no result, report no result rather than broadening to unrelated namespace content.
