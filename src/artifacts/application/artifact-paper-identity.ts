import { normalizeDoi } from "../../literature/domain/literature-identifiers.ts";

export interface ArtifactPaperIdentity {
	title?: string;
	authors?: string[];
	doi?: string;
	projectNames?: string[];
}

const GENERIC_PROJECT_NAMES = new Set(["API", "CPU", "DOI", "GCC", "GPU", "LLVM", "PDF"]);

function pdfInfoValue(info: string, key: string): string | undefined {
	const match = new RegExp(`^${key}:\\s*(.+)$`, "im").exec(info);
	const value = match?.[1]?.trim();
	return value || undefined;
}

function plausibleTitle(value: string | undefined): string | undefined {
	if (!value || value.length < 8 || value.length > 500 || /^(untitled|microsoft word|arxiv)/i.test(value)) {
		return undefined;
	}
	return value.replace(/\s+/g, " ").trim();
}

function textTitle(text: string): string | undefined {
	const firstPage = text.replaceAll("\r\n", "\n").split("\f", 1)[0] ?? "";
	for (const line of firstPage.split("\n").slice(0, 30)) {
		const title = plausibleTitle(line.trim());
		if (title && !/^(abstract|proceedings|technical report|doi\b|session\s+[a-z0-9-]+\b)/i.test(title)) return title;
	}
	return undefined;
}

function projectNames(text: string): string[] | undefined {
	const names = new Map<string, string>();
	const add = (value: string | undefined) => {
		const name = value?.replace(/[.,;:)]+$/, "").trim();
		if (!name || name.length < 3 || name.length > 40 || GENERIC_PROJECT_NAMES.has(name.toUpperCase())) return;
		names.set(name.toLowerCase(), name);
	};
	for (const match of text.matchAll(
		/\b(?:system|tool|framework|prototype)\s*,?\s*(?:namely|called|named)\s+([A-Z][A-Za-z0-9_-]{2,39})/g,
	)) {
		add(match[1]);
	}
	for (const match of text.matchAll(
		/\b(?:propose|present|introduce|develop|implement)[^.\n]{0,180}\(([A-Z][A-Z0-9-]{2,15})\)/gi,
	)) {
		add(match[1]);
	}
	for (const match of text.matchAll(
		/\bwe\s+(?:present|introduce|develop|build|implement)\s+([A-Z][A-Za-z0-9_-]{2,39})\b/g,
	)) {
		add(match[1]);
	}
	return names.size ? [...names.values()].slice(0, 8) : undefined;
}

function parseAuthors(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const authors = value
		.split(/\s*(?:;|\band\b)\s*/i)
		.map((author) => author.trim())
		.filter(Boolean);
	return authors.length ? authors : undefined;
}

export function inferArtifactPaperIdentity(info: string, text: string): ArtifactPaperIdentity | undefined {
	const doiMatch = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i.exec(text);
	const identity: ArtifactPaperIdentity = {
		title: plausibleTitle(pdfInfoValue(info, "Title")) ?? textTitle(text),
		authors: parseAuthors(pdfInfoValue(info, "Author")),
		doi: doiMatch ? normalizeDoi(doiMatch[0]) : undefined,
		projectNames: projectNames(text),
	};
	return identity.title || identity.doi || identity.authors?.length || identity.projectNames?.length
		? identity
		: undefined;
}
