import { setTimeout as delay } from "node:timers/promises";
import type { BackgroundJobContext } from "../../shared/domain/background-job.ts";
import { normalizeArxivId } from "../domain/literature-identifiers.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import type { ArxivNewsBatch, ArxivNewsStore } from "../infrastructure/arxiv-news-store.ts";
import { searchArxivPage } from "../infrastructure/provider-arxiv.ts";

export interface ArxivNewsPullInput {
	namespace: string;
	categories: string[];
	startDate: string;
	endDate: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY =
	/^(?:cs|econ|eess|math|physics|q-bio|q-fin|stat|astro-ph|cond-mat|gr-qc|hep-ex|hep-lat|hep-ph|hep-th|math-ph|nlin|nucl-ex|nucl-th|quant-ph)(?:\.[A-Za-z-]+)?$/;

export function validateArxivNewsDate(value: string): string {
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	if (!DATE.test(value) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
		throw new Error("Date must be a valid UTC date (YYYY-MM-DD)");
	}
	return value;
}

export function validateArxivNewsCategories(values: string[]): string[] {
	const categories = [...new Set(values.map((value) => value.trim()))].sort();
	if (!categories.length || categories.length > 20 || categories.some((value) => !CATEGORY.test(value))) {
		throw new Error("Select 1–20 valid arXiv subject categories");
	}
	return categories;
}

export function validateArxivNewsPull(input: ArxivNewsPullInput): ArxivNewsPullInput {
	const startDate = validateArxivNewsDate(input.startDate);
	const endDate = validateArxivNewsDate(input.endDate);
	if (startDate >= endDate) throw new Error("End date must be after start date (exclusive UTC end)");
	if (endDate > new Date().toISOString().slice(0, 10)) throw new Error("End date must not be in the future (UTC)");
	return { ...input, startDate, endDate, categories: validateArxivNewsCategories(input.categories) };
}

function nextUtcDate(value: string): string {
	const date = new Date(`${value}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}

let nextArxivNewsRequestAt = 0;

async function waitForRateLimit(signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
	const scheduledAt = Math.max(Date.now(), nextArxivNewsRequestAt);
	nextArxivNewsRequestAt = scheduledAt + 3_000;
	const waitMs = scheduledAt - Date.now();
	if (waitMs > 0) await delay(waitMs, undefined, { signal });
	if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
}

export async function pullArxivNews(
	store: ArxivNewsStore,
	input: ArxivNewsPullInput,
	context: BackgroundJobContext,
	search: typeof searchArxivPage = searchArxivPage,
	wait: (signal: AbortSignal) => Promise<void> = waitForRateLimit,
): Promise<{ batches: ArxivNewsBatch[]; count: number; lastSuccessAt: string }> {
	const request = validateArxivNewsPull(input);
	const totalDays = Math.round((Date.parse(request.endDate) - Date.parse(request.startDate)) / 86_400_000);
	const batches: ArxivNewsBatch[] = [];
	let count = 0;
	let completedDays = 0;
	for (let date = request.startDate; date < request.endDate; date = nextUtcDate(date)) {
		const records = new Map<string, PaperRecord>();
		let cursor: string | undefined;
		do {
			if (context.signal.aborted) throw context.signal.reason ?? new Error("Cancelled");
			const start = Number(cursor ?? "0");
			if (start >= 30_000) throw new Error(`arXiv result limit reached on ${date}; this day was not saved`);
			const page = await search({
				query: "*",
				limit: 100,
				cursor,
				filters: { arxivSubmittedFrom: date, arxivSubmittedTo: date },
				arxivCategories: request.categories,
				signal: context.signal,
				beforeAttempt: () => wait(context.signal),
			});
			for (const record of page.records) {
				const id = normalizeArxivId(record.identifiers.arxivId);
				if (id && record.firstSubmittedAt?.slice(0, 10) === date) {
					records.set(id, { ...record, identifiers: { ...record.identifiers, arxivId: id } });
				}
			}
			cursor = page.nextCursor;
			context.report(Math.min(0.95, (completedDays + 0.5) / totalDays), `正在拉取 ${date} · ${records.size} 篇`);
		} while (cursor);
		if (context.signal.aborted) throw context.signal.reason ?? new Error("Cancelled");
		const batch = await store.savePull({
			namespace: request.namespace,
			categories: request.categories,
			date,
			papers: [...records.values()],
		});
		batches.push(batch);
		count += records.size;
		completedDays += 1;
		context.report(
			Math.min(0.95, completedDays / totalDays),
			`已保存 ${completedDays}/${totalDays} 天；下次起点 ${nextUtcDate(date)}`,
		);
	}
	const state = await store.state(request.namespace);
	context.report(1, `已完成 ${completedDays} 天，本次拉取 ${count} 篇`);
	return { batches, count, lastSuccessAt: state.lastSuccessAt ?? new Date().toISOString() };
}
