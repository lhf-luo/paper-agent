import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import {
	pullArxivNews,
	validateArxivNewsDate,
	validateArxivNewsPull,
} from "../src/literature/application/arxiv-news.ts";
import { screenNewsPapers, validateNewsFilterGroups } from "../src/literature/application/arxiv-news-screening.ts";
import type { PaperRecord, ProviderPage } from "../src/literature/domain/literature-types.ts";
import { ARXIV_NEWS_NAMESPACE, ArxivNewsStore } from "../src/literature/infrastructure/arxiv-news-store.ts";
import { searchArxivPage } from "../src/literature/infrastructure/provider-arxiv.ts";
import type { ProviderSearchOptions } from "../src/literature/infrastructure/provider-common.ts";
import type { BackgroundJobContext } from "../src/shared/domain/background-job.ts";

const paths: string[] = [];
afterEach(async () => {
	await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<{ store: ArxivNewsStore; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-arxiv-news-"));
	paths.push(root);
	const path = join(root, "news.sqlite");
	return { store: new ArxivNewsStore(path), path };
}

function paper(id: string, date: string): PaperRecord {
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
	it("queries subjects and submission dates, spacing a retry as well as the first attempt", async () => {
		let attempts = 0;
		const urls: URL[] = [];
		const page = await searchArxivPage({
			query: "*",
			limit: 10,
			arxivCategories: ["cs.AI", "cs.LG"],
			filters: { arxivSubmittedFrom: "2026-10-02", arxivSubmittedTo: "2026-10-02" },
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
			searchArxivPage({
				query: "*",
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
				namespace: "default",
				categories: ["cs.AI"],
				startDate: "2026-10-02",
				endDate: "2026-10-02",
			}),
		).toThrow("exclusive UTC end");
	});

	it("queries selected subjects together, saves each UTC day, and merges a repeated day", async () => {
		const { store, path } = await temporaryStore();
		await store.saveSettings("default", ["cs.AI", "cs.LG"], "2026-10-02");
		const calls: string[] = [];
		let repeated = false;
		const search = async (options: ProviderSearchOptions): Promise<ProviderPage> => {
			expect(options.limit).toBe(100);
			const date = options.filters?.arxivSubmittedFrom ?? "";
			calls.push(`${date}:${options.arxivCategories?.join("|")}:${options.cursor ?? "0"}`);
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
				namespace: "default",
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
		expect((await store.state("default")).nextStartDate).toBe("2026-10-04");
		repeated = true;
		const second = await pullArxivNews(
			store,
			{
				namespace: "default",
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
		expect((await store.state("default")).batches).toHaveLength(2);
		const database = new DatabaseSync(path);
		expect(
			(database.prepare("SELECT COUNT(*) AS count FROM arxiv_news_items").get() as { count: number }).count,
		).toBe(3);
		database.close();
		await store.deleteBatch("default", first.batches[0].id);
		expect((await store.batch("default", first.batches[1].id))?.papers).toHaveLength(1);
		await store.deleteBatch("default", first.batches[1].id);
		const after = new DatabaseSync(path);
		expect((after.prepare("SELECT COUNT(*) AS count FROM arxiv_news_items").get() as { count: number }).count).toBe(
			0,
		);
		after.close();
	});

	it("keeps successful folders and cursor unchanged when a later page fails", async () => {
		const { store } = await temporaryStore();
		await store.saveSettings("default", ["cs.AI"], "2026-10-02");
		const existing = await store.savePull({
			namespace: "default",
			categories: ["cs.AI"],
			date: "2026-10-02",
			papers: [paper("2610.00001", "2026-10-02")],
		});
		const before = await store.state("default");
		let count = 0;
		await expect(
			pullArxivNews(
				store,
				{
					namespace: "default",
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
		expect((await store.state("default")).lastSuccessAt).toBe(before.lastSuccessAt);
		expect((await store.state("default")).nextStartDate).toBe("2026-10-03");
		expect((await store.batch("default", existing.id))?.papers).toHaveLength(1);
		expect((await store.state("other")).batches).toEqual([]);
	});

	it("saves October 10 and 11 separately, then resumes at October 12 after a later day fails", async () => {
		const { store } = await temporaryStore();
		await store.saveSettings("default", ["cs.AI", "cs.LG"], "2026-10-10");
		const dates: string[] = [];
		const search = async (options: ProviderSearchOptions): Promise<ProviderPage> => {
			const date = options.filters?.arxivSubmittedFrom ?? "";
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
				{ namespace: "default", categories: ["cs.AI", "cs.LG"], startDate: "2026-10-10", endDate: "2026-10-13" },
				context,
				search,
				noWait,
			),
		).rejects.toThrow("HTTP 429");
		expect(dates).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
		expect(await store.state("default")).toMatchObject({
			nextStartDate: "2026-10-12",
			batches: [{ name: "2026-10-11" }, { name: "2026-10-10" }],
		});
		const resumed = await pullArxivNews(
			store,
			{ namespace: "default", categories: ["cs.AI", "cs.LG"], startDate: "2026-10-10", endDate: "2026-10-12" },
			context,
			search,
			noWait,
		);
		expect(resumed.batches.map((batch) => batch.name)).toEqual(["2026-10-10", "2026-10-11"]);
		expect((await store.state("default")).nextStartDate).toBe("2026-10-12");
		expect((await store.state("default")).batches).toHaveLength(2);
	});

	it("creates an empty daily table and advances the next start date", async () => {
		const { store } = await temporaryStore();
		await store.saveSettings("default", ["cs.AI"]);
		const result = await pullArxivNews(
			store,
			{
				namespace: "default",
				categories: ["cs.AI"],
				startDate: "2026-10-02",
				endDate: "2026-10-03",
			},
			context,
			async () => ({ provider: "arxiv", query: "*", records: [], requestUrl: "https://arxiv.org/test" }),
			noWait,
		);
		expect(result.batches).toMatchObject([{ name: "2026-10-02", count: 0 }]);
		expect(await store.state("default")).toMatchObject({ nextStartDate: "2026-10-03" });
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

	it("shares paper metadata by arXiv ID without exposing another namespace's folders", async () => {
		const { store, path } = await temporaryStore();
		const input = {
			categories: ["cs.AI"],
			date: "2026-10-02",
			papers: [paper("2610.00001", "2026-10-02")],
		};
		const first = await store.savePull({ ...input, namespace: "first" });
		const second = await store.savePull({ ...input, namespace: "second" });
		expect((await store.state("first")).batches).toHaveLength(1);
		expect((await store.state("second")).batches).toHaveLength(1);
		expect(await store.batch("first", second.id)).toBeUndefined();
		const database = new DatabaseSync(path);
		expect(
			(database.prepare("SELECT COUNT(*) AS count FROM arxiv_news_items").get() as { count: number }).count,
		).toBe(1);
		database.close();
		await store.deleteBatch("first", first.id);
		expect((await store.batch("second", second.id))?.papers).toHaveLength(1);
	});

	it("serves a standalone news run and leaves personal libraries empty until explicit import", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-news-web-"));
		paths.push(root);
		const dataRoot = join(root, ".paper-agent");
		const staticRoot = join(root, "dist", "web");
		await mkdir(staticRoot, { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<html>News test</html>");
		const store = new ArxivNewsStore(join(dataRoot, "runtime", "arxiv-news.sqlite"));
		await store.saveSettings(ARXIV_NEWS_NAMESPACE, ["cs.AI"], "2026-10-02");
		const batch = await store.savePull({
			namespace: ARXIV_NEWS_NAMESPACE,
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
			const state = await fetch(`${server.url}/api/arxiv-news?namespace=some-personal-library`);
			expect(state.status).toBe(200);
			const stateBody = (await state.json()) as {
				batches: Array<{ id: string; count: number }>;
				filterGroups: Array<{ label: string }>;
			};
			expect(stateBody.batches).toMatchObject([{ id: batch.id, count: 1 }]);
			expect(stateBody.filterGroups[0]?.label).toBe("内核漏洞—静态/程序分析");
			const detail = await fetch(`${server.url}/api/arxiv-news/batches/${batch.id}?namespace=another-library`);
			expect((await detail.json()) as unknown).toMatchObject({
				papers: [{ id: "arxiv:2610.00001" }],
				screening: { matchedIds: ["arxiv:2610.00001"] },
			});
			expect(await application.personalStore("personal").getPaper("arxiv:2610.00001")).toBeUndefined();
			const prepared = await fetch(`${server.url}/api/library/import/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ newsBatchId: batch.id, paperIds: ["arxiv:2610.00001"], namespace: "personal" }),
			});
			expect(prepared.status, await prepared.clone().text()).toBe(200);
			const preparedBody = (await prepared.json()) as { operationId: string; manifestFingerprint: string };
			expect(await application.personalStore("personal").getPaper("arxiv:2610.00001")).toBeUndefined();
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
			expect((await store.state(ARXIV_NEWS_NAMESPACE)).filterGroups).toEqual(customGroups);
			const rescreened = await fetch(`${server.url}/api/arxiv-news/batches/${batch.id}`);
			expect((await rescreened.json()) as unknown).toMatchObject({
				screening: { matchedIds: [], filteredCount: 1 },
			});
			const grant = await application.confirmOperation(preparedBody.operationId, preparedBody.manifestFingerprint);
			await expect(
				application.enqueueAuthorizedCorpusImport(
					{ newsBatchId: batch.id, paperIds: ["arxiv:2610.00001"], namespace: "personal" },
					grant,
				),
			).rejects.toThrow("News screening changed");
			await expect(
				application.prepareCorpusImport({
					newsBatchId: batch.id,
					paperIds: ["arxiv:2610.00001"],
					namespace: "personal",
				}),
			).rejects.toThrow("Only papers retained");
			await store.savePull({
				namespace: ARXIV_NEWS_NAMESPACE,
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
					namespace: "personal",
				}),
			).resolves.toMatchObject({ kind: "personal-corpus-write" });
		} finally {
			await server.close();
			await application.close();
		}
	});
});
