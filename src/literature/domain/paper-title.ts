/**
 * Title hygiene for library records.
 *
 * Titles arrive from publisher pages, PDF metadata, arXiv/ACL XML, browser captures and
 * Doi enrichment, and routinely carry markup, entity escapes and page boilerplate
 * (`<i>ECG</i>: …`, `See discussions, stats, and author profiles …`, `… - PDF`,
 * `… | SpringerLink`). Cleaning is intentionally conservative: subtitles, years and
 * venue names must survive untouched.
 */

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

function decodeEntities(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
		if (code.startsWith("#")) {
			const hex = code.startsWith("#x") || code.startsWith("#X");
			const point = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
			return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
		}
		return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
	});
}

/**
 * Boilerplate that prefixes capture/export artifacts rather than belonging to the title.
 * Anchored at the start so a title merely *containing* the phrase is left alone.
 */
const JUNK_PREFIXES: RegExp[] = [
	/^see discussions?,?\s*stats,?\s*and author profiles for this publication at\s*:?\s*/i,
	/^downloaded from\s+\S+\s*/i,
	/^downloaded (?:by|on)\b[^.]*?\.\s*/i,
	/^article in\s+/i,
	/^preprint\s*:?\s+/i,
	/^pdf\s*:?\s+/i,
	/^arxiv:\s*\S+\s*/i,
	/^doi:\s*\S+\s*/i,
	// Capture tools often prefix the canonical URL; a real title never starts with one.
	/^https?:\/\/\S+\s*/i,
];

/**
 * Boilerplate that trails the title: publisher badges, file markers and bare identifiers.
 */
const JUNK_SUFFIXES: RegExp[] = [
	/\s*\|\s*(?:springerlink|springer|ieee xplore|acm digital library|sciencedirect|wiley online library|nature\.com|arxiv|researchgate|semantic scholar)\s*$/i,
	/\s*[-–—]\s*pdf\s*$/i,
	/\s*[-–—]\s*(?:preprint|postprint|author copy|accepted manuscript)\s*$/i,
	/\s*[-–—]\s*arxiv:\s*\S+\s*$/i,
	/\s*\barxiv:\s*\S+\s*$/i,
	/\s*[-–—]\s*doi:\s*\S+\s*$/i,
	/\s*\bdoi:\s*\S+\s*$/i,
	/\s*\.pdf\s*$/i,
	/\s+\bpdf\s*$/i,
];

/** Only trimmed when something else was stripped, so real titles are never touched. */
const LEADING_SEPARATOR = /^[-–—|:;,]\s*/;
const TRAILING_SEPARATOR = /[\s\-–—|:;,]+$/;

function stripMarkup(value: string): string {
	// Decode then strip, twice: upstream XML often double-encodes markup
	// (`&amp;lt;i&amp;gt;`), and a single pass leaves literal tags behind.
	let text = value;
	for (let pass = 0; pass < 2; pass++) {
		text = decodeEntities(text);
		text = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ");
	}
	return decodeEntities(text);
}

const SUPERSCRIPT: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	n: "ⁿ",
	i: "ⁱ",
};

const SUBSCRIPT: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
};

/** Symbols that appear in paper titles and abstracts, whether inside `$…$` or bare. */
const LATEX_COMMANDS: Record<string, string> = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	pi: "π",
	rho: "ρ",
	sigma: "σ",
	tau: "τ",
	upsilon: "υ",
	phi: "φ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	pm: "±",
	mp: "∓",
	times: "×",
	cdot: "·",
	div: "÷",
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	neq: "≠",
	ne: "≠",
	approx: "≈",
	sim: "∼",
	propto: "∝",
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	int: "∫",
	sum: "∑",
	prod: "∏",
	sqrt: "√",
	in: "∈",
	notin: "∉",
	subset: "⊂",
	supset: "⊃",
	cup: "∪",
	cap: "∩",
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	leftrightarrow: "↔",
	degree: "°",
	circ: "∘",
	angstrom: "Å",
	// Escaped punctuation is a literal character in LaTeX.
	"%": "%",
	"&": "&",
	"#": "#",
	_: "_",
	$: "$",
	"{": "{",
	"}": "}",
	"\\": "\\",
	" ": " ",
	",": " ",
	";": " ",
	":": " ",
	"!": "",
	quad: " ",
	qquad: " ",
};

function toScript(value: string, table: Record<string, string>): string | undefined {
	let out = "";
	for (const character of value) {
		const mapped = table[character];
		if (mapped === undefined) return undefined;
		out += mapped;
	}
	return out || undefined;
}

/**
 * `^{15}`/`^{-1}`/`_2` → unicode scripts. Only applied inside math spans, because outside
 * them a caret or underscore is ordinary text (`foo_bar` must not become `fooᵦₐᵣ`).
 */
function convertScripts(value: string): string {
	return value
		.replace(/\^\{([^{}]*)\}/g, (_match, content: string) => toScript(content, SUPERSCRIPT) ?? content)
		.replace(/\^([^\s{}])/g, (match, character: string) => toScript(character, SUPERSCRIPT) ?? match)
		.replace(/_\{([^{}]*)\}/g, (_match, content: string) => toScript(content, SUBSCRIPT) ?? content)
		.replace(/_([^\s{}])/g, (match, character: string) => toScript(character, SUBSCRIPT) ?? match);
}

function replaceLatexCommands(value: string): string {
	return (
		value
			// \frac{a}{b} reads better as a/b than as "fracab".
			.replace(/\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
			// `\emph{x}`, `\mathrm{x}`, … wrap text: keep the content, drop the command.
			.replace(
				/\\([a-zA-Z]+)\s*\{([^{}]*)\}/g,
				(_match, name: string, content: string) => LATEX_COMMANDS[name] ?? content,
			)
			.replace(/\\([a-zA-Z]+)/g, (_match, name: string) => LATEX_COMMANDS[name] ?? name)
			.replace(/\\(.)/g, (match, character: string) => LATEX_COMMANDS[character] ?? match)
	);
}

/**
 * Converts the LaTeX that arXiv, Crossref and ACL put in titles and abstracts into plain
 * text: `$^{15}$C` → `¹⁵C`, `$\pm$` → `±`, `H$_2$O` → `H₂O`, `\&` → `&`.
 */
export function cleanLatex(value: string): string {
	let text = value
		// Math spans first: their contents are where `^`/`_` mean scripts.
		.replace(/\$([^$]*)\$/g, (_match, inner: string) => convertScripts(inner))
		.replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner: string) => convertScripts(inner))
		.replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner: string) => convertScripts(inner));
	text = replaceLatexCommands(text);
	// Leftover braces are markup, and a leftover `$` is an unmatched delimiter.
	return text.replace(/[{}]/g, "").replace(/\$/g, "").replace(/~/g, " ");
}

function stripJunkAffixes(value: string): string {
	let text = value;
	let changed = true;
	while (changed) {
		changed = false;
		for (const pattern of JUNK_PREFIXES) {
			const next = text.replace(pattern, "");
			if (next !== text) {
				text = next;
				changed = true;
			}
		}
		for (const pattern of JUNK_SUFFIXES) {
			const next = text.replace(pattern, "");
			if (next !== text) {
				text = next;
				changed = true;
			}
		}
	}
	if (text !== value) {
		text = text.replace(LEADING_SEPARATOR, "").replace(TRAILING_SEPARATOR, "");
	}
	return text;
}

function collapseWhitespace(value: string): string {
	return (
		value
			.replace(/[\u0000-\u001f\u007f]+/g, " ")
			.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
			.replace(/\s+/g, " ")
			// Removing a tag can leave a space stranded before its punctuation (`ECG </i>: …`).
			.replace(/\s+([:;,.)\]}?!])/g, "$1")
			.trim()
	);
}

/**
 * Cleans a paper title for storage and display. Returns the cleaned title, or the
 * whitespace-collapsed original when cleaning would leave nothing behind.
 */
export function cleanPaperTitle(value: string | undefined | null): string {
	if (!value) return "";
	const original = collapseWhitespace(value.normalize("NFKC").replace(/\u00ad/g, ""));
	if (!original) return "";

	const cleaned = collapseWhitespace(stripJunkAffixes(cleanLatex(stripMarkup(original))));
	return cleaned || original;
}

/**
 * Cleans free-form metadata such as an abstract: markup and LaTeX only, since affix
 * stripping and punctuation tidying are title-specific.
 */
export function cleanPaperText(value: string | undefined | null): string {
	if (!value) return "";
	const original = collapseWhitespace(value.normalize("NFKC").replace(/\u00ad/g, ""));
	if (!original) return "";
	const cleaned = cleanLatex(stripMarkup(original)).replace(/\s+/g, " ").trim();
	return cleaned || original;
}

/** True when {@link cleanPaperTitle} would change the value, i.e. the stored title is dirty. */
export function paperTitleNeedsCleaning(value: string | undefined | null): boolean {
	const cleaned = cleanPaperTitle(value);
	return Boolean(cleaned) && cleaned !== (value ?? "");
}

/**
 * Returns the record with a cleaned title and abstract, or the record unchanged when there is
 * nothing to clean. Applied at the storage boundary so every write path is covered.
 */
export function withCleanMetadata<T extends { title: string; abstract?: string }>(record: T): T {
	const title = cleanPaperTitle(record.title);
	const abstract = typeof record.abstract === "string" ? cleanPaperText(record.abstract) : undefined;
	const titleChanged = Boolean(title) && title !== record.title;
	const abstractChanged = abstract !== undefined && abstract !== record.abstract;
	if (!titleChanged && !abstractChanged) return record;
	return {
		...record,
		...(titleChanged ? { title } : {}),
		...(abstractChanged ? { abstract } : {}),
	};
}
