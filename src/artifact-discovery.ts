import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import type { CommandExecutor } from "./command-executor.ts";
import { normalizeDoi, sha256Text } from "./literature-identifiers.ts";
import type { ArtifactCandidate, ArtifactManifest } from "./literature-types.ts";

const knownArtifactHosts = new Set([
	"bitbucket.org",
	"codeberg.org",
	"dataverse.harvard.edu",
	"doi.org",
	"figshare.com",
	"github.com",
	"gitlab.com",
	"huggingface.co",
	"osf.io",
	"paperswithcode.com",
	"sourceforge.net",
	"zenodo.org",
]);

const repositoryHosts = new Set(["bitbucket.org", "codeberg.org", "github.com", "gitlab.com"]);
const datasetHosts = new Set(["dataverse.harvard.edu", "figshare.com", "huggingface.co", "osf.io", "zenodo.org"]);
const projectHosts = new Set(["paperswithcode.com"]);

const githubNonRepositoryPrefixes = new Set([
	"about",
	"apps",
	"collections",
	"contact",
	"customer-stories",
	"enterprise",
	"events",
	"explore",
	"features",
	"issues",
	"login",
	"marketplace",
	"new",
	"organizations",
	"orgs",
	"pricing",
	"pulls",
	"readme",
	"search",
	"security",
	"settings",
	"signup",
	"site",
	"sponsors",
	"topics",
	"trending",
]);

const genericNonRepositoryPrefixes = new Set([
	"about",
	"dashboard",
	"explore",
	"features",
	"help",
	"login",
	"pricing",
	"search",
	"signup",
	"topics",
	"users",
]);

export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

function stripUrlPunctuation(value: string): string {
	let cleaned = value.trim().replace(/[\u200b\u00ad]/g, "");
	while (/[),.;:'"\]}。；，）】》]$/.test(cleaned)) cleaned = cleaned.slice(0, -1);
	return cleaned;
}

function normalizeCandidateUrl(raw: string): URL | undefined {
	const normalized = /^www\./i.test(raw) ? "https://" + raw : raw;
	try {
		const url = new URL(stripUrlPunctuation(normalized));
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.username || url.password) return undefined;
		url.hash = "";
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		if (host.endsWith(".github")) return undefined;
		if (knownArtifactHosts.has(host)) url.hostname = host;
		const parts = url.pathname.split("/").filter(Boolean);
		if (repositoryHosts.has(host)) {
			if (parts.length < 2) return undefined;
			const prefix = parts[0].toLowerCase();
			if (
				host === "github.com" ? githubNonRepositoryPrefixes.has(prefix) : genericNonRepositoryPrefixes.has(prefix)
			) {
				return undefined;
			}
			if (!parts[0] || !parts[1] || parts[0] === "." || parts[0] === ".." || parts[1] === "." || parts[1] === "..") {
				return undefined;
			}
		}
		if (knownArtifactHosts.has(host) && parts.length === 0) return undefined;
		return url;
	} catch {
		return undefined;
	}
}

function classify(url: URL): ArtifactCandidate["kind"] {
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	if (repositoryHosts.has(host)) return "repository";
	if (datasetHosts.has(host)) return "dataset";
	if (projectHosts.has(host)) return "project";
	if (/\b(?:code|github|gitlab|dataset|data|supplement|artifact|repository)\b/i.test(url.pathname)) {
		return "supplement";
	}
	return "unknown";
}

export function canonicalArtifactUrl(value: URL | string): string {
	const url = typeof value === "string" ? new URL(value) : value;
	const copy = new URL(url);
	copy.hostname = copy.hostname.toLowerCase().replace(/^www\./, "");
	copy.hash = "";
	const parts = copy.pathname.split("/").filter(Boolean);
	if (copy.hostname === "github.com" || copy.hostname === "bitbucket.org" || copy.hostname === "codeberg.org") {
		if (parts.length >= 2) copy.pathname = "/" + [parts[0], parts[1].replace(/\.git$/i, "")].join("/");
		copy.search = "";
	} else if (copy.hostname === "gitlab.com") {
		const marker = parts.indexOf("-");
		const repositoryParts = (marker >= 0 ? parts.slice(0, marker) : parts).map((part, index, all) =>
			index === all.length - 1 ? part.replace(/\.git$/i, "") : part,
		);
		if (repositoryParts.length >= 2) copy.pathname = "/" + repositoryParts.join("/");
		copy.search = "";
	} else {
		copy.searchParams.sort();
		copy.pathname = copy.pathname.replace(/\/+$/, "") || "/";
	}
	return copy.href;
}

function contextAround(text: string, index: number, length: number): string {
	const start = Math.max(0, index - 160);
	const end = Math.min(text.length, index + length + 160);
	return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function sentenceAround(text: string, index: number, length: number): string {
	const before = text.slice(0, index);
	const boundary = Math.max(
		before.lastIndexOf("."),
		before.lastIndexOf("!"),
		before.lastIndexOf("?"),
		before.lastIndexOf("\n"),
	);
	const afterStart = index + length;
	const after = text.slice(afterStart);
	const endings = [after.indexOf("."), after.indexOf("!"), after.indexOf("?"), after.indexOf("\n")].filter(
		(value) => value >= 0,
	);
	const end = endings.length ? afterStart + Math.min(...endings) + 1 : text.length;
	return text
		.slice(boundary + 1, end)
		.replace(/\s+/g, " ")
		.trim();
}

function proseWithoutUrls(sentence: string): string {
	return sentence
		.replace(/https?:\/\/[^\s<>{}|\\^\x60]+/gi, " ")
		.replace(/www\.[a-z0-9.-]+\.[a-z]{2,}\/[^\s<>{}|\\^\x60]*/gi, " ")
		.replace(
			/(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|zenodo\.org|figshare\.com|osf\.io|huggingface\.co)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi,
			" ",
		)
		.replace(/(\p{L})-\s+(\p{L})/gu, "$1$2")
		.replace(/\s+/g, " ")
		.trim();
}

function candidateConfidence(sentence: string, context: string): ArtifactCandidate["confidence"] {
	const authorRelease =
		/\b(?:we|our|the authors?)\b.{0,80}\b(?:release|released|provide|provided|publish|published|open-source|make|made|available|hosted|archived|accessible|accessed|found|located)\b/i.test(
			sentence,
		);
	if (authorRelease) return "high";
	const citationOrLicense =
		/\b(?:bibliography|references|licensed under|license file|copyright notice|accessed\s*:)\b/i.test(sentence) ||
		/\[(?:online|[a-z]*\d+[a-z+\s-]*)\]/i.test(sentence) ||
		/\[online\].{0,160}\bavailable\s*:/i.test(context) ||
		/\b(?:proceedings of|transactions on|technical report)\b/i.test(sentence);
	if (citationOrLicense) return "low";
	const directAvailability =
		/\b(?:our\s+)?(?:source\s+code|code|implementation|artifact|data\s*set|dataset|data|sample|supplement(?:ary material)?)\b.{0,40}\b(?:(?:is|are|was|were|has been|have been|can be|may be)\s+)?(?:publicly\s+)?(?:available|released|provided|published|archived|hosted|downloadable|accessible|accessed|found|located)\b/i.test(
			sentence,
		);
	if (directAvailability) return "high";
	const genericArtifactContext =
		/\b(?:artifact|source\s+code|code|implementation|repository|data\s*set|dataset|sample|supplement(?:ary material)?|project page|available at)\b/i.test(
			sentence,
		);
	if (genericArtifactContext) return "medium";
	return "low";
}

export function extractArtifactCandidates(
	text: string,
	method: ArtifactCandidate["sources"][number]["method"],
	page?: number,
): ArtifactCandidate[] {
	const matches: Array<{ raw: string; index: number }> = [];
	for (const match of text.matchAll(
		/https?:\/\/[^\s<>{}|\\^\x60]+|www\.[a-z0-9.-]+\.[a-z]{2,}\/[^\s<>{}|\\^\x60]*/gi,
	)) {
		if (match.index !== undefined) matches.push({ raw: match[0], index: match.index });
	}
	for (const match of text.matchAll(
		/(?<![\w@/])(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|zenodo\.org|figshare\.com|osf\.io|huggingface\.co)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi,
	)) {
		if (match.index !== undefined) matches.push({ raw: "https://" + match[0], index: match.index });
	}
	const candidates = new Map<string, ArtifactCandidate>();
	for (const match of matches) {
		const url = normalizeCandidateUrl(match.raw);
		if (!url) continue;
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		const context = contextAround(text, match.index, match.raw.length);
		const confidenceContext = text
			.slice(Math.max(0, match.index - 120), Math.min(text.length, match.index + match.raw.length + 40))
			.replace(/\s+/g, " ")
			.trim();
		const sentence = sentenceAround(text, match.index, match.raw.length);
		const prose = proseWithoutUrls(sentence);
		const kind = classify(url);
		const contextSignals =
			/\b(?:artifact|source\s+code|code|implementation|repository|data\s*set|dataset|sample|supplement|project page|available at)\b/i.test(
				prose,
			);
		if (!knownArtifactHosts.has(host) && kind === "unknown" && !contextSignals) continue;
		if (host === "doi.org" && !contextSignals) continue;
		const canonical = canonicalArtifactUrl(url);
		const source = { method, page, context, url: url.href };
		const existing = candidates.get(canonical);
		if (existing) {
			if (
				!existing.sources.some(
					(item) =>
						item.method === source.method &&
						item.page === source.page &&
						item.context === source.context &&
						item.url === source.url,
				)
			) {
				existing.sources.push(source);
			}
			const confidence = candidateConfidence(prose, confidenceContext);
			if (confidence === "high") existing.confidence = "high";
			else if (confidence === "medium" && existing.confidence === "low") existing.confidence = "medium";
			continue;
		}
		candidates.set(canonical, {
			id: "artifact-" + sha256Text(canonical).slice(0, 16),
			url: canonical,
			kind,
			host,
			sources: [source],
			confidence: candidateConfidence(prose, confidenceContext),
		});
	}
	return [...candidates.values()];
}

function mergeCandidates(groups: ArtifactCandidate[][]): ArtifactCandidate[] {
	const merged = new Map<string, ArtifactCandidate>();
	for (const candidate of groups.flat()) {
		const existing = merged.get(candidate.url);
		if (!existing) {
			merged.set(candidate.url, candidate);
			continue;
		}
		for (const source of candidate.sources) {
			if (
				!existing.sources.some(
					(item) =>
						item.method === source.method &&
						item.page === source.page &&
						item.context === source.context &&
						item.url === source.url,
				)
			) {
				existing.sources.push(source);
			}
		}
		if (candidate.confidence === "high") existing.confidence = "high";
		else if (candidate.confidence === "medium" && existing.confidence === "low") existing.confidence = "medium";
	}
	return [...merged.values()].sort((left, right) => left.url.localeCompare(right.url));
}

export async function discoverArtifactsFromPdf(
	pi: CommandExecutor,
	pdfPath: string,
	signal?: AbortSignal,
): Promise<ArtifactManifest> {
	const [infoResult, textResult, pdfSha256] = await Promise.all([
		pi.exec("pdfinfo", ["-url", pdfPath], { cwd: dirname(pdfPath), signal, timeout: 30_000 }),
		pi.exec("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
			cwd: dirname(pdfPath),
			signal,
			timeout: 120_000,
		}),
		sha256File(pdfPath),
	]);
	if (textResult.code !== 0 || textResult.killed || signal?.aborted) {
		const reason = signal?.aborted
			? "operation aborted"
			: textResult.killed
				? "pdftotext timed out"
				: textResult.stderr.trim() || "pdftotext exited with a non-zero status";
		throw new Error("Could not extract artifact links from PDF: " + reason);
	}
	const groups: ArtifactCandidate[][] = [];
	if (infoResult.code === 0) groups.push(extractArtifactCandidates(infoResult.stdout, "pdfinfo-url"));
	const pages = textResult.stdout.replaceAll("\r\n", "\n").split("\f");
	for (let index = 0; index < pages.length; index++) {
		groups.push(extractArtifactCandidates(pages[index], "pdftotext", index + 1));
	}
	const doiPattern = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi;
	for (const match of textResult.stdout.matchAll(doiPattern)) {
		const doi = normalizeDoi(match[0]);
		if (!doi || match.index === undefined) continue;
		const context = contextAround(textResult.stdout, match.index, match[0].length);
		if (!/\b(?:artifact|code|dataset|data|supplement|repository)\b/i.test(context)) continue;
		groups.push(extractArtifactCandidates("https://doi.org/" + doi + " " + context, "doi-derived"));
	}
	return {
		schemaVersion: 1,
		pdfPath,
		pdfSha256,
		discoveredAt: new Date().toISOString(),
		candidates: mergeCandidates(groups),
		acquisitions: [],
	};
}
