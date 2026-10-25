import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { pullArxivNews } from "../src/literature/application/arxiv-news.ts";
import { type ArxivNewsPaper, validateArxivNewsDate, validateArxivNewsPull } from "../src/literature/domain/arxiv-news.ts";
import { screenNewsPapers, validateNewsFilterGroups } from "../src/literature/application/arxiv-news-screening.ts";
import { ArxivNewsStore } from "../src/literature/infrastructure/arxiv-news-store.ts";
import { fetchArxivNewsPage, type ArxivNewsFetchOptions, type ArxivNewsPage } from "../src/literature/infrastructure/arxiv-news-source.ts";
import type { BackgroundJobContext } from "../src/shared/domain/background-job.ts";

const paths: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<{ store: ArxivNewsStore; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-arxiv-news-"));
	paths.push(root);
	const path = join(root, "news.sqlite");
	return { store: new ArxivNewsStore(path), path };
}

function paper(id: string, date: string): ArxivNewsPaper {
	return {
		id: `arxiv:${id}`,
		title: `Paper ${id}`,
		authors: ["Ada"],
		year: Number(date.slice(0, 4)),
		firstSubmittedAt: `${date}T12:00:00Z`,
		identifiers: { arxivId: id },
		links: [{ url: `https://arxiv.org/abs/${id}`, kind: "landing" }],
		provenance: [],
		mergedFrom: [],
	};
}

const context: BackgroundJobContext = {
	jobId: "test",
	signal: new AbortController().signal,
	report: () => {},
};
const noWait = async () => {};

describe("arXiv news", () => {
	it("parses first submission times, filters UTC days and respects the Atom total for paging", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const entry = (id: string, date: string) => `<entry><id>https://arxiv.org/abs/${id}</id><title>News &amp; paper</title><summary>Abstract</summary><published>${date}T12:00:00Z</published><updated>2026-10-03T12:00:00Z</updated><author><name>Ada</name></author></entry>`;
		const page = await fetchArxivNewsPage({ date: "2026-10-02", categories: ["cs.AI"], limit: 2, cursor: "2", fetcher: async () => new Response(`<feed><opensearch:totalResults>4</opensearch:totalResults>${entry("2610.00001v2", "2026-10-02")}${entry("2610.00002", "2026-10-01")}</feed>`) });
		expect(timeout).toHaveBeenCalledWith(60_000);
		expect(page.records).toMatchObject([{ title: "News & paper", identifiers: { arxivId: "2610.00001" }, firstSubmittedAt: "2026-10-02T12:00:00Z" }]);
		expect(page.records).toHaveLength(1);
		expect(page.nextCursor).toBeUndefined();
		const url = new URL(page.requestUrl);
		expect(url.searchParams.get("sortBy")).toBe("submittedDate");
		expect(url.searchParams.get("sortOrder")).toBe("descending");
	});

	it("deduplicates versioned arXiv IDs across news pages", async () => {
		const { store } = await temporaryStore();
		const result = await pullArxivNews(store, { categories: ["cs.AI"], startDate: "2026-10-02", endDate: "2026-10-03" }, context, async (options) => ({
			provider: "arxiv", query: "news", records: [paper(options.cursor ? "2610.00001v2" : "2610.00001v1", options.date)], nextCursor: options.cursor ? undefined : "100", requestUrl: "https://arxiv.org/test",
		}), noWait);
		expect(result.count).toBe(1);
		expect((await store.batch(result.batches[0].id))?.papers[0].identifiers.arxivId).toBe("2610.00001");
	});

	it("preserves completed dates and discards the incomplete day on cancellation", async () => {
		const { store } = await temporaryStore();
		await store.saveSettings(["cs.AI"], "2026-10-02");
		const controller = new AbortController();
		const search = async (options: ArxivNewsFetchOptions): Promise<ArxivNewsPage> => {
			if (options.date === "2026-10-03") controller.abort(new Error("Cancelled"));
			return { provider: "arxiv", query: "news", records: [paper("2610.00001", options.date)], requestUrl: "https://arxiv.org/test" };
		};
		await expect(pullArxivNews(store, { categories: ["cs.AI"], startDate: "2026-10-02", endDate: "2026-10-04" }, { ...context, signal: controller.signal }, search, noWait)).rejects.toThrow("Cancelled");
		expect(await store.state()).toMatchObject({ nextStartDate: "2026-10-03", batches: [{ name: "2026-10-02" }] });
		expect((await store.state()).batches).toHaveLength(1);
	});

	it("does not save a day truncated by arXiv's result limit or a non-progressing cursor", async () => {
		for (const nextCursor of ["30000", "0"]) {
			const { store } = await temporaryStore();
			await expect(pullArxivNews(store, { categories: ["cs.AI"], startDate: "2026-10-02", endDate: "2026-10-03" }, context, async () => ({ provider: "arxiv", query: "news", records: [paper("2610.00001", "2026-10-02")], nextCursor, requestUrl: "https://arxiv.org/test" }), noWait)).rejects.toThrow(nextCursor === "30000" ? "result limit" : "pagination");
			expect((await store.state()).batches).toHaveLength(0);
		}
	});

	it("queries subjects and submission dates, spacing a retry as well as the first attempt", async () => {
		let attempts = 0;
		const urls: URL[] = [];
		const page = await fetchArxivNewsPage({
			limit: 10,
			categories: ["cs.AI", "cs.LG"],
			date: "2026-10-02",
			beforeAttempt: async () => {
				attempts++;
			},
			fetcher: async (input) => {
				urls.push(new URL(String(input)));
				return urls.length === 1 ? new Response("rate limited", { status: 429 }) : new Response("<feed></feed>");
			},
		});
		expect(attempts).toBe(2);
		expect(page.records).toEqual([]);
		expect(urls[0].searchParams.get("search_query")).toBe(
			"(cat:cs.AI OR cat:cs.LG) AND submittedDate:[202610020000 TO 202610022359]",
		);
	});

	it("reports a stalled arXiv response body with the page offset", async () => {
		await expect(
			fetchArxivNewsPage({
				date: "2026-10-02",
				categories: ["cs.AI"],
				limit: 100,
				cursor: "100",
				fetcher: async () =>
					new Response(
						new ReadableStream({
							pull(controller) {
								controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
							},
						}),
						{ status: 200 },
					),
			}),
		).rejects.toThrow("arXiv page at offset 100 timed out after 60 seconds");
	});

	it("validates actual UTC calendar days", () => {
		expect(validateArxivNewsDate("2026-10-02")).toBe("2026-10-02");
		expect(() => validateArxivNewsDate("2026-02-30")).toThrow("valid UTC date");
		expect(() => validateArxivNewsDate("9999-99-99")).toThrow("valid UTC date");
		expect(() =>
			validateArxivNewsPull({
				categories: ["cs.AI"],
				startDate: "2026-10-02",
				endDate: "2026-10-02",
			}),
		).toThrow("exclusive UTC end");
	});

	it("queries selected subjects together, saves each UTC day, and merges a repeated day", async () => {
		const { store, path } = await temporaryStore();
		await store.saveSettings(["cs.AI", "cs.LG"], "2026-10-02");
		const calls: string[] = [];
		let repeated = false;
		const search = async (options: ArxivNewsFetchOptions): Promise<ArxivNewsPage> => {
			expect(options.limit).toBe(100);
			const date = options.date;
			calls.push(`${date}:${options.categories?.join("|")}:${options.cursor ?? "0"}`);
			const records =
				date === "2026-10-02" ? [paper(repeated ? "2610.00003" : "2610.00001", date)] : [paper("2610.00002", date)];
			return {
				provider: "arxiv",
				query: "*",
				records,
				nextCursor: date === "2026-10-02" && !repeated && !options.cursor ? "500" : undefined,
				requestUrl: "https://arxiv.org/test",
			};
		};
		const first = await pullArxivNews(
			store,
			{
				categories: ["cs.LG", "cs.AI"],
				startDate: "2026-10-02",
				endDate: "2026-10-04",
			},
			context,
			search,
			noWait,
		);
		expect(first.batches).toMatchObject([
			{ name: "2026-10-02", count: 1 },
			{ name: "2026-10-03", count: 1 },
		]);
		expect(calls).toEqual(["2026-10-02:cs.AI|cs.LG:0", "2026-10-02:cs.AI|cs.LG:500", "2026-10-03:cs.AI|cs.LG:0"]);
		expect((await store.state()).nextStartDate).toBe("2026-10-04");
		repeated = true;
		const second = await pullArxivNews(
			store,
			{
				categories: ["cs.AI"],
				startDate: "2026-10-02",
				endDate: "2026-10-03",
			},
			context,
			search,
			noWait,
		);
		expect(second.batches[0]?.id).toBe(first.batches[0]?.id);
		expect(second.batches[0]).toMatchObject({ count: 2, categories: ["cs.AI", "cs.LG"] });
		expect(calls).toHaveLength(4);
		expect((await store.state()).batches).toHaveLength(2);
		const database = new DatabaseSync(path);
		expect(
			(database.prepare("SELECT COUNT(*) AS count FROM arxiv_news_items").get() as { count: number }).count,
		).toBe(3);
		database.close();
		await store.deleteBatch(first.batches[0].id);
		expect((await store.batch(first.batches[1].id))?.papers).toHaveLength(1);
		await store.deleteBatch(first.batches[1].id);
		const after = new DatabaseSync(path);
		expect((after.prepare("SELECT COUNT(*) AS count FROM arxiv_news_items").get() as { count: number }).count).toBe(
			0,
		);
		after.close();
	});

	it("keeps successful folders and cursor unchanged when a later page fails", async () => {
		const { store } = await temporaryStore();
		await store.saveSettings(["cs.AI"], "2026-10-02");
		const existing = await store.savePull({
			categories: ["cs.AI"],
			date: "2026-10-02",
			papers: [paper("2610.00001", "2026-10-02")],
		});
		const before = await store.state();
		let count = 0;
		await expect(
			pullArxivNews(
				store,
				{
					categories: ["cs.AI"],
					startDate: "2026-10-03",
					endDate: "2026-10-04",
				},
				context,
				async () => {
					count++;
					if (count === 2) throw new Error("arXiv rate limited");
					return {
						provider: "arxiv",
						query: "*",
						records: [paper("2610.00002", "2026-10-03")],
						nextCursor: "500",
						requestUrl: "https://arxiv.org/test",
					};
				},
				noWait,
			),
		).rejects.toThrow("arXiv rate limited");
		expect((await store.state()).lastSuccessAt).toBe(before.lastSuccessAt);
		expect((await store.state()).nextStartDate).toBe("2026-10-03");
		expect((await store.batch(existing.id))?.papers).toHaveLength(1);
		expect((await store.state()).batches).toHaveLength(1);
	});

	it("saves October 10 and 11 separately, then resumes at October 12 after a later day fails", async () => {
		const { store } = await temporaryStore();
		await store.saveSettings(["cs.AI", "cs.LG"], "2026-10-10");
		const dates: string[] = [];
		const search = async (options: ArxivNewsFetchOptions): Promise<ArxivNewsPage> => {
			const date = options.date;
			dates.push(date);
			if (date === "2026-10-12") throw new Error("arXiv returned HTTP 429");
			return {
				provider: "arxiv",
				query: "*",
				records: [paper(date === "2026-10-10" ? "2610.00010" : "2610.00011", date)],
				requestUrl: "https://arxiv.org/test",
			};
		};
		await expect(
			pullArxivNews(
				store,
				{ categories: ["cs.AI", "cs.LG"], startDate: "2026-10-10", endDate: "2026-10-13" },
				context,
				search,
				noWait,
			),
		).rejects.toThrow("HTTP 429");
		expect(dates).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
		expect(await store.state()).toMatchObject({
			nextStartDate: "2026-10-12",
			batches: [{ name: "2026-10-11" }, { name: "2026-10-10" }],
		});
		const resumed = await pullArxivNews(
			store,
			{ categories: ["cs.AI", "cs.LG"], startDate: "2026-10-10", endDate: "2026-10-12" },
			context,
			search,
			noWait,
		);
		expect(resumed.batches.map((batch) => batch.name)).toEqual(["2026-10-10", "2026-10-11"]);
		expect((await store.state()).nextStartDate).toBe("2026-10-12");
		expect((await store.state()).batches).toHaveLength(2);
	});

	it("creates an empty daily table and advances the next start date", async () => {
		const { store } = await temporaryStore();
		await store.saveSettings(["cs.AI"]);
		const result = await pullArxivNews(
			store,
			{
				categories: ["cs.AI"],
				startDate: "2026-10-02",
				endDate: "2026-10-03",
			},
			context,
			async () => ({ provider: "arxiv", query: "*", records: [], requestUrl: "https://arxiv.org/test" }),
			noWait,
		);
		expect(result.batches).toMatchObject([{ name: "2026-10-02", count: 0 }]);
		expect(await store.state()).toMatchObject({ nextStartDate: "2026-10-03" });
	});

	it("applies OR within concepts, AND across concepts, and keeps absent abstracts unresolved", async () => {
		const groups = validateNewsFilterGroups([
			{
				label: "内核静态分析",
				with_abstract: {
					include_term_groups: [
						["Linux kernel", "kernel driver"],
						["static analysis", "typestate"],
					],
					exclude_terms: ["malware"],
					exclude_scope: "title",
				},
				without_abstract: {
					include_term_groups: [
						["Linux kernel", "kernel driver"],
						["static analysis", "typestate"],
					],
				},
			},
		]);
		const matched = {
			...paper("2610.00011", "2026-10-02"),
			title: "A kernel driver checker",
			abstract: "A typestate analysis of vulnerabilities",
		};
		const unresolved = { ...paper("2610.00012", "2026-10-02"), title: "Linux kernel static analysis" };
		const excluded = {
			...paper("2610.00013", "2026-10-02"),
			title: "Malware in the Linux kernel",
			abstract: "A static analysis",
		};
		const result = screenNewsPapers([matched, unresolved, excluded], groups);
		expect(result.matchedIds).toEqual([matched.id]);
		expect(result.unresolvedIds).toEqual([unresolved.id]);
		expect(result.filteredCount).toBe(1);
		expect(() => validateNewsFilterGroups([{ ...groups[0], without_abstract: {} }])).toThrow("positive include rule");
	});

	it("shares paper metadata across category batches", async () => {
		const { store, path } = await temporaryStore();
		const input = {
			categories: ["cs.AI"],
			date: "2026-10-02",
			papers: [paper("2610.00001", "2026-10-02")],
		};
		const first = await store.savePull({ ...input });
		const second = await store.savePull({ ...input, date: "2026-10-03" });
		expect((await store.state()).batches).toHaveLength(2);
		expect((await store.batch(second.id))?.papers).toHaveLength(1);
		const database = new DatabaseSync(path);
		expect(
			(database.prepare("SELECT COUNT(*) AS count FROM arxiv_news_items").get() as { count: number }).count,
		).toBe(1);
		database.close();
		await store.deleteBatch(first.id);
		expect((await store.batch(second.id))?.papers).toHaveLength(1);
	});

	it("serves a standalone news run and leaves personal libraries empty until explicit import", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-news-web-"));
		paths.push(root);
		const dataRoot = join(root, ".paper-agent");
		const staticRoot = join(root, "dist", "web");
		await mkdir(staticRoot, { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>News test</html>");
		const store = new ArxivNewsStore(join(dataRoot, "runtime", "arxiv-news.sqlite"));
		await store.saveSettings(["cs.AI"], "2026-10-02");
		const batch = await store.savePull({
			categories: ["cs.AI"],
			date: "2026-10-02",
			papers: [
				{
					...paper("2610.00001", "2026-10-02"),
					title: "Linux kernel static analysis",
					abstract: "A typestate approach to vulnerability detection",
				},
			],
		});
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot });
		const server = await startLocalWebServer(application, { staticRoot });
		try {
			const state = await fetch(`${server.url}/api/arxiv-news`);
			expect(state.status).toBe(200);
			const stateBody = (await state.json()) as {
				batches: Array<{ id: string; count: number }>;
				filterGroups: Array<{ label: string }>;
			};
			expect(stateBody.batches).toMatchObject([{ id: batch.id, count: 1 }]);
			expect(stateBody.filterGroups[0]?.label).toBe("内核漏洞—静态/程序分析");
			const detail = await fetch(`${server.url}/api/arxiv-news/batches/${batch.id}`);
			expect((await detail.json()) as unknown).toMatchObject({
				papers: [{ id: "arxiv:2610.00001" }],
				screening: { matchedIds: ["arxiv:2610.00001"] },
			});
			expect(await application.personalStore().getPaper("arxiv:2610.00001")).toBeUndefined();
			const prepared = await fetch(`${server.url}/api/library/import/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ newsBatchId: batch.id, paperIds: ["arxiv:2610.00001"] }),
			});
			expect(prepared.status, await prepared.clone().text()).toBe(200);
			const preparedBody = (await prepared.json()) as { operationId: string; manifestFingerprint: string };
			expect(await application.personalStore().getPaper("arxiv:2610.00001")).toBeUndefined();
			const customGroups = validateNewsFilterGroups([
				{
					label: "LLM",
					with_abstract: { include_terms: ["large language model"] },
					without_abstract: { include_terms: ["LLM"] },
				},
			]);
			const changed = await fetch(`${server.url}/api/arxiv-news/settings`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ categories: ["cs.AI"], filterGroups: customGroups }),
			});
			expect(changed.status).toBe(200);
			expect((await store.state()).filterGroups).toEqual(customGroups);
			const rescreened = await fetch(`${server.url}/api/arxiv-news/batches/${batch.id}`);
			expect((await rescreened.json()) as unknown).toMatchObject({
				screening: { matchedIds: [], filteredCount: 1 },
			});
			const grant = await application.confirmOperation(preparedBody.operationId, preparedBody.manifestFingerprint);
			await expect(
				application.enqueueAuthorizedCorpusImport({ newsBatchId: batch.id, paperIds: ["arxiv:2610.00001"] }, grant),
			).rejects.toThrow("News screening changed");
			await expect(
				application.prepareCorpusImport({
					newsBatchId: batch.id,
					paperIds: ["arxiv:2610.00001"],
				}),
			).rejects.toThrow("Only papers retained");
			await store.savePull({
				categories: ["cs.AI"],
				date: "2026-10-02",
				papers: [{ ...paper("2610.00002", "2026-10-02"), title: "LLM study" }],
			});
			const unresolvedDetail = await fetch(`${server.url}/api/arxiv-news/batches/${batch.id}`);
			expect((await unresolvedDetail.json()) as unknown).toMatchObject({
				screening: { unresolvedIds: ["arxiv:2610.00002"] },
			});
			await expect(
				application.prepareCorpusImport({
					newsBatchId: batch.id,
					paperIds: ["arxiv:2610.00002"],
				}),
			).resolves.toMatchObject({ kind: "personal-corpus-write" });
		} finally {
			await server.close();
			await application.close();
		}
	});
});
