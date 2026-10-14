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
