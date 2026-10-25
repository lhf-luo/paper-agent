export interface NewsFilterRule {
	include_terms?: string[];
	include_term_groups?: string[][];
	exclude_terms?: string[];
	exclude_scope?: "title" | "title+abstract";
	year_from?: number;
	year_to?: number;
	venue_rank?: "A" | "B" | "C";
}

export interface NewsFilterGroup {
	label?: string;
	with_abstract: NewsFilterRule;
	without_abstract: Omit<NewsFilterRule, "exclude_scope">;
}

const kernel = [
	"Linux kernel",
	"OS kernel",
	"operating system kernel",
	"kernel driver",
	"kernel vulnerability",
	"kernel bug",
];
const staticTerms = [
	"static analysis",
	"program analysis",
	"typestate",
	"taint analysis",
	"data-flow analysis",
	"path-sensitive",
	"alias-aware",
	"static detection",
	"static race",
	"static deadlock",
];
const llmTerms = ["large language model", "LLM", "language model", "agentic", "multi-agent"];

/** Initial profile from the user's filter_search_run_results example. */
export const DEFAULT_NEWS_FILTER_GROUPS: NewsFilterGroup[] = [
	{
		label: "内核漏洞—静态/程序分析",
		with_abstract: {
			year_from: 2022,
			year_to: 2026,
			include_term_groups: [kernel, staticTerms],
			exclude_terms: ["malware", "smart contract", "web application", "Android application", "teaching"],
			exclude_scope: "title",
		},
		without_abstract: {
			year_from: 2022,
			year_to: 2026,
			include_term_groups: [
				kernel.slice(0, 4),
				[
					"static analysis",
					"program analysis",
					"typestate",
					"taint",
					"static detection",
					"static race",
					"static deadlock",
				],
			],
			exclude_terms: ["malware", "smart contract", "web application", "teaching"],
		},
	},
	{
		label: "内核漏洞—LLM",
		with_abstract: {
			year_from: 2022,
			year_to: 2026,
			include_term_groups: [[...kernel, "kernel crash", "kernel security"], llmTerms],
			exclude_terms: ["malware", "smart contract", "teaching", "course"],
			exclude_scope: "title",
		},
		without_abstract: {
			year_from: 2022,
			year_to: 2026,
			include_term_groups: [[...kernel, "kernel crash"], llmTerms],
			exclude_terms: ["malware", "smart contract", "teaching", "course"],
		},
	},
];

function readTerms(input: Record<string, unknown>, key: string, name: string): string[] | undefined {
	const items = input[key];
	if (items === undefined) return undefined;
	if (
		!Array.isArray(items) ||
		items.length > 60 ||
		items.some((item) => typeof item !== "string" || !item.trim() || item.length > 160)
	)
		throw new Error(`${name}.${key} must contain 0–60 nonempty terms`);
	return items.map((item: string) => item.trim());
}

function readTermGroups(input: Record<string, unknown>, name: string): string[][] | undefined {
	const value = input.include_term_groups;
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > 12 ||
		value.some(
			(group) =>
				!Array.isArray(group) ||
				!group.length ||
				group.length > 20 ||
				group.some((item) => typeof item !== "string" || !item.trim() || item.length > 160),
		)
	)
		throw new Error(`${name}.include_term_groups must contain 0–12 nonempty concept groups`);
	return (value as string[][]).map((group) => group.map((item) => item.trim()));
}

function rule(value: unknown, name: string, withoutAbstract: boolean): NewsFilterRule {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const input = value as Record<string, unknown>;
	const allowed = new Set([
		"include_terms",
		"include_term_groups",
		"exclude_terms",
		"year_from",
		"year_to",
		"venue_rank",
		...(withoutAbstract ? [] : ["exclude_scope"]),
	]);
	if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error(`${name} has an unsupported field`);
	const includeTerms = readTerms(input, "include_terms", name);
	const excludeTerms = readTerms(input, "exclude_terms", name);
	const includeTermGroups = readTermGroups(input, name);
	if (includeTerms?.length && includeTermGroups?.length)
		throw new Error(`${name}: include_terms and include_term_groups cannot be combined`);
	if (withoutAbstract && !includeTerms?.length && !includeTermGroups?.length)
		throw new Error(`${name} needs a positive include rule`);
	for (const key of ["year_from", "year_to"])
		if (
			input[key] !== undefined &&
			(!Number.isInteger(input[key]) || (input[key] as number) < 1000 || (input[key] as number) > 9999)
		)
			throw new Error(`${name}.${key} must be a year from 1000 to 9999`);
	if (input.year_from && input.year_to && input.year_from > input.year_to)
		throw new Error(`${name}: year_from must not exceed year_to`);
	if (input.venue_rank !== undefined && !["A", "B", "C"].includes(input.venue_rank as string))
		throw new Error(`${name}.venue_rank is invalid`);
	if (input.exclude_scope !== undefined && !["title", "title+abstract"].includes(input.exclude_scope as string))
		throw new Error(`${name}.exclude_scope is invalid`);
	return {
		...(includeTerms ? { include_terms: includeTerms } : {}),
		...(includeTermGroups ? { include_term_groups: includeTermGroups } : {}),
		...(excludeTerms ? { exclude_terms: excludeTerms } : {}),
		...(input.exclude_scope ? { exclude_scope: input.exclude_scope as NewsFilterRule["exclude_scope"] } : {}),
		...(input.year_from ? { year_from: input.year_from as number } : {}),
		...(input.year_to ? { year_to: input.year_to as number } : {}),
		...(input.venue_rank ? { venue_rank: input.venue_rank as NewsFilterRule["venue_rank"] } : {}),
	};
}

export function validateNewsFilterGroups(value: unknown): NewsFilterGroup[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("筛选规则需包含 1–8 个 groups");
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new Error(`groups[${index}] must be an object`);
		const group = item as Record<string, unknown>;
		if (Object.keys(group).some((key) => !["label", "with_abstract", "without_abstract"].includes(key)))
			throw new Error(`groups[${index}] has an unsupported field`);
		if (
			group.label !== undefined &&
			(typeof group.label !== "string" || !group.label.trim() || group.label.length > 100)
		)
			throw new Error(`groups[${index}].label is invalid`);
		return {
			...(group.label ? { label: (group.label as string).trim() } : {}),
			with_abstract: rule(group.with_abstract, `groups[${index}].with_abstract`, false),
			without_abstract: rule(group.without_abstract, `groups[${index}].without_abstract`, true),
		};
	});
}

