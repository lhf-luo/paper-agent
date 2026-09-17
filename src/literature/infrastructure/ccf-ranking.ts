import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

interface IndexedEntry {
	entry: CcfEntry;
	/** 规范化缩写。 */
	acronym: string;
	/** 规范化全称。 */
	name: string;
	/** 全称的有效词, 已去掉停用词、年份与届次。 */
	tokens: Set<string>;
	/** 会议(true) 还是期刊(false)。 */
	conference: boolean;
}

interface CcfIndex {
	byAcronym: Map<string, IndexedEntry[]>;
	byName: Map<string, IndexedEntry[]>;
	entries: IndexedEntry[];
}

let cache: CcfEntry[] | undefined;
let index: CcfIndex | undefined;

function loadEntries(): CcfEntry[] {
	if (cache) return cache;
	try {
		const directory = dirname(fileURLToPath(import.meta.url));
		const raw = readFileSync(join(directory, "..", "..", "..", "data", "ccf-2026.json"), "utf8");
		cache = JSON.parse(raw) as CcfEntry[];
	} catch (error) {
		throw new Error("Failed to load bundled CCF ranking data (data/ccf-2026.json)", { cause: error });
	}
	return cache;
}

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.trim();
}

/** 全称里不参与词匹配的虚词。 */
const STOP_WORDS = new Set(["a", "an", "and", "at", "de", "for", "in", "of", "on", "the", "to", "with"]);

function tokenize(value: string): Set<string> {
	const tokens = new Set<string>();
	for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
		if (!token || STOP_WORDS.has(token)) continue;
		// 年份与届次(2023、46th)不参与匹配, 否则会拉低覆盖率。
		if (/^\d+$/.test(token) || /^\d+(st|nd|rd|th)$/.test(token)) continue;
		tokens.add(token);
	}
	return tokens;
}

/** 去掉 venue 开头或末尾的年份, 例如 "SC 2023"、"2023 USENIX Security"。 */
function stripYears(value: string): string {
	return value
		.replace(/[\s,]*\(?\b(?:19|20)\d{2}[a-z]?\)?\s*$/i, "")
		.replace(/^\s*\(?\b(?:19|20)\d{2}[a-z]?\)?[\s,]*/i, "")
		.trim();
}

/**
 * 常见写法与 CCF 目录缩写不一致时的显式映射(规范化 venue -> 规范化 CCF 缩写)。
 * 只收录缩写本身表达不了的写法。
 */
const VENUE_ALIASES: Record<string, string> = {
	nips: "neurips",
	ieeesp: "sp",
	oakland: "sp",
	atc: "acmsigops",
	usenixatc: "acmsigops",
	kdd: "sigkdd",
};

/**
 * 缩写冲突时的默认取舍(规范化缩写 -> 规范化全称)。
 * 这些缩写对应多个 CCF 条目且缩写本身不足以区分, 取检索场景中最常见的那个。
 * venue 文本里若带了足以区分的线索(如完整全称或配对写作), 线索优先于本表。
 */
const ACRONYM_PREFERENCES: Record<string, string> = {
	// ESEC/FSE(软件工程旗舰) 与 FSE/Fast Software Encryption(对称密码) 缩写相同。
	fse: "acm international conference on the foundations of software engineering",
	// 同名会议与期刊并列时取会议。
	www: "international world wide web conference",
	cscw: "acm conference on computer-supported cooperative work and social computing",
	ase: "international conference on automated software engineering",
	re: "ieee international requirements engineering conference",
	cc: "international conference on compiler construction",
	aamas: "international joint conference on autonomous agents and multi-agent systems",
	tcc: "theory of cryptography conference",
	sec: "acm/ieee symposium on edge computing",
	im: "ifip/ieee international symposium on integrated network management",
	dke: "data & knowledge engineering",
	ipl: "information processing letters",
	ijis: "international journal of intelligent systems",
};

function buildIndex(entries: CcfEntry[]): CcfIndex {
	const byAcronym = new Map<string, IndexedEntry[]>();
	const byName = new Map<string, IndexedEntry[]>();
	const indexed: IndexedEntry[] = [];
	for (const entry of entries) {
		if (!isCcfLevel(entry.rank)) continue;
		const item: IndexedEntry = {
			entry,
			acronym: normalize(entry.acronym_alnum ?? entry.acronym),
			name: normalize(entry.name),
			tokens: tokenize(entry.name),
			conference: entry.type === "conference",
		};
		indexed.push(item);
		// acronym 与 acronym_alnum 都登记, 目录里两者偶有不一致。
		for (const key of new Set([normalize(entry.acronym), item.acronym])) {
			if (!key) continue;
			const bucket = byAcronym.get(key);
			if (bucket) bucket.push(item);
			else byAcronym.set(key, [item]);
		}
		const nameBucket = byName.get(item.name);
		if (nameBucket) nameBucket.push(item);
		else byName.set(item.name, [item]);
	}
	return { byAcronym, byName, entries: indexed };
}

function getIndex(): CcfIndex {
	if (!index) index = buildIndex(loadEntries());
	return index;
}

function countOverlap(tokens: Set<string>, other: Set<string>): number {
	let count = 0;
	for (const token of tokens) if (other.has(token)) count += 1;
	return count;
}

const JOURNAL_CONTEXT = new Set(["journal", "transactions", "letters", "magazine"]);
const CONFERENCE_CONTEXT = new Set(["conference", "congress", "symposium"]);
const EXCLUDED_RESULT_CONTEXT = new Set(["workshop", "poster", "demo", "demonstration", "tutorial", "companion"]);

function candidatesForTypeContext(candidates: IndexedEntry[], venueTokens: Set<string>): IndexedEntry[] {
	const wantsJournal = [...JOURNAL_CONTEXT].some((token) => venueTokens.has(token));
	const wantsConference = [...CONFERENCE_CONTEXT].some((token) => venueTokens.has(token));
	if (wantsJournal && !wantsConference) return candidates.filter((candidate) => !candidate.conference);
	if (wantsConference && !wantsJournal) return candidates.filter((candidate) => candidate.conference);
	return candidates;
}

function candidateMatchesExcludedContext(candidate: IndexedEntry, venueTokens: Set<string>): boolean {
	for (const token of EXCLUDED_RESULT_CONTEXT) {
		if (venueTokens.has(token) && !candidate.tokens.has(token)) return false;
	}
	if (venueTokens.has("short") && (venueTokens.has("paper") || venueTokens.has("papers"))) return false;
	return true;
}

function chooseUnambiguous(candidates: IndexedEntry[], venueTokens: Set<string>): IndexedEntry | undefined {
	const contextual = candidatesForTypeContext(candidates, venueTokens);
	if (contextual.length === 0) return undefined;
	const eligible = contextual.filter((candidate) => candidateMatchesExcludedContext(candidate, venueTokens));
	if (eligible.length === 0) return undefined;
	const ranks = new Set(eligible.map((candidate) => candidate.entry.rank));
	return ranks.size === 1 ? eligible[0] : undefined;
}

/** 缩写对应多个条目时选一个: 类型/全称词线索优先, 其次显式偏好。 */
function chooseByAcronym(
	candidates: IndexedEntry[],
	acronym: string,
	venueTokens: Set<string>,
): IndexedEntry | undefined {
	const contextual = candidatesForTypeContext(candidates, venueTokens);
	if (contextual.length === 0) return undefined;
	candidates = contextual.filter((candidate) => candidateMatchesExcludedContext(candidate, venueTokens));
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];

	const scored = candidates.map((candidate) => ({
		candidate,
		overlap: countOverlap(candidate.tokens, venueTokens),
	}));
	const bestOverlap = Math.max(...scored.map((item) => item.overlap));
	const top =
		bestOverlap > 0
			? scored.filter((item) => item.overlap === bestOverlap).map((item) => item.candidate)
			: candidates;
	if (top.length === 1) return top[0];

	const preference = ACRONYM_PREFERENCES[acronym];
	if (preference) {
		const preferred = top.find((candidate) => candidate.name === normalize(preference));
		if (preferred) return preferred;
	}

	return undefined;
}

/** venue 里内嵌了一个完整 CCF 全称, 且该全称占 venue 的足够比例。 */
function matchByNameContained(venueName: string, venueTokens: Set<string>, idx: CcfIndex): IndexedEntry | undefined {
	let longest = 0;
	let matches: IndexedEntry[] = [];
	for (const candidate of idx.entries) {
		if (candidate.name.length < 8 || candidate.name.length / venueName.length < 0.5) continue;
		if (!venueName.includes(candidate.name)) continue;
		if (countOverlap(candidate.tokens, venueTokens) !== candidate.tokens.size) continue;
		if (candidate.name.length > longest) {
			longest = candidate.name.length;
			matches = [candidate];
		} else if (candidate.name.length === longest) matches.push(candidate);
	}
	return chooseUnambiguous(matches, venueTokens);
}

/** venue 里以独立词出现的缩写(如 "Proc. INFOCOM 2023" 中的 INFOCOM)。 */
function matchByAcronymWord(words: string[], idx: CcfIndex): IndexedEntry | undefined {
	let best: { entry: IndexedEntry; token: string } | undefined;
	for (const word of words) {
		if (word.length < 3) continue;
		const candidates = idx.byAcronym.get(word);
		if (!candidates?.length) continue;
		if (!best || word.length > best.token.length) {
			const entry = chooseByAcronym(candidates, word, new Set(words));
			if (entry) best = { entry, token: word };
		}
	}
	return best?.entry;
}

/** 全称的词被 venue 充分覆盖时, 取最具体的那个(venue 里未匹配词最少)。 */
function matchByTokenOverlap(venueTokens: Set<string>, idx: CcfIndex): IndexedEntry | undefined {
	let best: { entry: IndexedEntry; precision: number } | undefined;
	for (const candidate of idx.entries) {
		if (candidate.tokens.size < 3) continue;
		// 允许 ccf 全称里的一两个词(如 CVPR 的 "CVF")不出现在 venue 文本中。
		const overlap = countOverlap(candidate.tokens, venueTokens);
		if (overlap / candidate.tokens.size < 0.8) continue;
		const precision = overlap / venueTokens.size;
		if (precision < 0.5) continue;
		if (!candidateMatchesExcludedContext(candidate, venueTokens)) continue;
		if (!best || precision > best.precision) best = { entry: candidate, precision };
	}
	return best?.entry;
}

/**
 * 根据 venue 字符串查 CCF 分级(2026)。
 * 匹配顺序: 写法别名 → 缩写精确 → 全称精确 → 全称内嵌 → 缩写成词 → 全称词覆盖。
 * 每条路径都要求证据足够强, 宁可返回 undefined 也不给出错误等级。
 */
export function lookupCcfLevel(venue: string | undefined): CcfLevel | undefined {
	const raw = (venue ?? "").trim();
	if (!raw) return undefined;
	const idx = getIndex();
	if (idx.entries.length === 0) return undefined;

	const stripped = stripYears(raw) || raw;
	const normalized = normalize(stripped);
	if (!normalized) return undefined;

	const venueTokens = tokenize(stripped);
	const words = stripped.toLowerCase().split(/[^a-z0-9]+/);

	const aliased = VENUE_ALIASES[normalized];
	if (aliased) {
		const candidates = idx.byAcronym.get(aliased);
		const chosen = candidates?.length ? chooseByAcronym(candidates, aliased, venueTokens) : undefined;
		if (chosen) return chosen.entry.rank as CcfLevel;
	}

	const byAcronym = idx.byAcronym.get(normalized);
	if (byAcronym?.length) {
		const chosen = chooseByAcronym(byAcronym, normalized, venueTokens);
		if (chosen) return chosen.entry.rank as CcfLevel;
	}

	const byName = idx.byName.get(normalized);
	if (byName?.length) {
		const chosen = chooseUnambiguous(byName, venueTokens);
		if (chosen) return chosen.entry.rank as CcfLevel;
		return undefined;
	}

	const contained = matchByNameContained(normalized, venueTokens, idx);
	if (contained) return contained.entry.rank as CcfLevel;

	const acronymWord = matchByAcronymWord(words, idx);
	if (acronymWord) return acronymWord.entry.rank as CcfLevel;

	const overlap = matchByTokenOverlap(venueTokens, idx);
	if (overlap) return overlap.entry.rank as CcfLevel;

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
