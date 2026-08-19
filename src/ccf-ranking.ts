import { readFileSync } from "node:fs";
import { dirname, join, } from "node:path";
import { fileURLToPath } from "node:url";

export type CcfLevel = "A" | "B" | "C";

interface CcfEntry {
	acronym: string;
	name: string;
	rank: string;
	type: string;
	field: string;
	acronym_alnum?: string;
}

let cache: CcfEntry[] | undefined;

function loadEntries(): CcfEntry[] {
	if (cache) return cache;
	try {
		const directory = dirname(fileURLToPath(import.meta.url));
		const raw = readFileSync(join(directory, "..", "data", "ccf-2026.json"), "utf8");
		cache = JSON.parse(raw) as CcfEntry[];
	} catch {
		cache = [];
	}
	return cache;
}

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.trim();
}

/**
 * 根据 venue 字符串查 CCF 分级(2026)。
 * 匹配策略: ① 精确匹配 acronym/name → ② 名称包含 → ③ 短 acronym 子串。
 * 返回 A/B/C; 匹配不到返回 undefined。
 */
export function lookupCcfLevel(venue: string | undefined): CcfLevel | undefined {
	const normalized = normalize(venue ?? "");
	if (!normalized) return undefined;
	const entries = loadEntries();
	if (entries.length === 0) return undefined;
	const exact = entries.find(
		(entry) =>
			normalize(entry.acronym) === normalized ||
			normalize(entry.name) === normalized ||
			normalize(entry.acronym_alnum ?? "") === normalized,
	);
	if (exact && isCcfLevel(exact.rank)) return exact.rank;
	const byName = entries
		.filter((entry) => normalized.includes(normalize(entry.name)) || normalize(entry.name).includes(normalized))
		.sort((left, right) => normalize(right.name).length - normalize(left.name).length);
	if (byName[0] && isCcfLevel(byName[0].rank)) return byName[0].rank;
	const byAcronym = entries
		.filter((entry) => normalize(entry.acronym).length >= 3 && normalized.includes(normalize(entry.acronym)))
		.sort((left, right) => normalize(right.acronym).length - normalize(left.acronym).length);
	if (byAcronym[0] && isCcfLevel(byAcronym[0].rank)) return byAcronym[0].rank;
	return undefined;
}

function isCcfLevel(value: string): value is CcfLevel {
	return value === "A" || value === "B" || value === "C";
}

export function ccfLevelLabel(level: CcfLevel): string {
	switch (level) {
		case "A":
			return "CCF-A";
		case "B":
			return "CCF-B";
		case "C":
			return "CCF-C";
	}
}

export function ccfEntriesForTool(): Array<{ acronym: string; name: string; rank: string; type: string }> {
	return loadEntries().map((entry) => ({
		acronym: entry.acronym,
		name: entry.name,
		rank: entry.rank,
		type: entry.type,
	}));
}
