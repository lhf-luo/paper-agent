import { setTimeout as delay } from "node:timers/promises";
import type { BackgroundJobContext } from "../../shared/domain/background-job.ts";
import { normalizeArxivId } from "../domain/literature-identifiers.ts";
import {
	nextUtcDate,
	validateArxivNewsPull,
	type ArxivNewsPaper,
	type ArxivNewsPullInput,
} from "../domain/arxiv-news.ts";
import type { ArxivNewsBatch, ArxivNewsStore } from "../infrastructure/arxiv-news-store.ts";
import { fetchArxivNewsPage } from "../infrastructure/arxiv-news-source.ts";

let nextArxivNewsRequestAt = 0;

async function waitForRateLimit(signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
	const scheduledAt = Math.max(Date.now(), nextArxivNewsRequestAt);
	nextArxivNewsRequestAt = scheduledAt + 3_000;
	const waitMs = scheduledAt - Date.now();
	if (waitMs > 0) await delay(waitMs, undefined, { signal });
	if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
}

async function pullNewsDay(
	date: string,
	categories: string[],
	context: BackgroundJobContext,
	search: typeof fetchArxivNewsPage,
	wait: (signal: AbortSignal) => Promise<void>,
	report: (count: number) => void,
): Promise<ArxivNewsPaper[]> {
	const records = new Map<string, ArxivNewsPaper>();
	let cursor: string | undefined;
	do {
		if (context.signal.aborted) throw context.signal.reason ?? new Error("Cancelled");
		const start = Number(cursor ?? "0");
		if (start >= 30_000) throw new Error(`arXiv result limit reached on ${date}; this day was not saved`);
		const page = await search({
			date,
			limit: 100,
			cursor,
			categories,
			signal: context.signal,
			beforeAttempt: () => wait(context.signal),
		});
		for (const record of page.records) {
			const id = normalizeArxivId(record.identifiers.arxivId);
			if (id && record.firstSubmittedAt?.slice(0, 10) === date) {
				records.set(id, { ...record, identifiers: { ...record.identifiers, arxivId: id } });
			}
		}
		if (page.nextCursor && (!Number.isInteger(Number(page.nextCursor)) || Number(page.nextCursor) <= start)) {
			throw new Error(`Invalid arXiv news pagination on ${date}; this day was not saved`);
		}
		cursor = page.nextCursor;
		report(records.size);
	} while (cursor);
	return [...records.values()];
}

export async function pullArxivNews(
	store: ArxivNewsStore,
	input: ArxivNewsPullInput,
	context: BackgroundJobContext,
	search: typeof fetchArxivNewsPage = fetchArxivNewsPage,
	wait: (signal: AbortSignal) => Promise<void> = waitForRateLimit,
): Promise<{ batches: ArxivNewsBatch[]; count: number; lastSuccessAt: string }> {
	const request = validateArxivNewsPull(input);
	const totalDays = Math.round((Date.parse(request.endDate) - Date.parse(request.startDate)) / 86_400_000);
	const batches: ArxivNewsBatch[] = [];
	let count = 0;
	let completedDays = 0;
	for (let date = request.startDate; date < request.endDate; date = nextUtcDate(date)) {
		const records = await pullNewsDay(date, request.categories, context, search, wait, (count) => {
			context.report(Math.min(0.95, (completedDays + 0.5) / totalDays), `正在拉取 ${date} · ${count} 篇`);
		});
		if (context.signal.aborted) throw context.signal.reason ?? new Error("Cancelled");
		const batch = await store.savePull({
			categories: request.categories,
			date,
			papers: records,
		});
		batches.push(batch);
		count += records.length;
		completedDays += 1;
		context.report(
			Math.min(0.95, completedDays / totalDays),
			`已保存 ${completedDays}/${totalDays} 天；下次起点 ${nextUtcDate(date)}`,
		);
	}
	const state = await store.state();
	context.report(1, `已完成 ${completedDays} 天，本次拉取 ${count} 篇`);
	return { batches, count, lastSuccessAt: state.lastSuccessAt ?? new Date().toISOString() };
}
