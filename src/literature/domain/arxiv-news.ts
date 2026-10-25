import type { PaperRecord } from "./literature-types.ts";

export interface ArxivNewsPaper extends PaperRecord {
	firstSubmittedAt: string;
}

export interface ArxivNewsPullInput {
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

export function nextUtcDate(value: string): string {
	const date = new Date(`${value}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}
