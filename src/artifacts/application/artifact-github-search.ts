import { normalizeDoi, sha256Text } from "../../literature/domain/literature-identifiers.ts";
import type { ArtifactCandidate, ArtifactManifest } from "../../literature/domain/literature-types.ts";
import type { AddressResolver } from "../../shared/infrastructure/network-address.ts";
import { readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { type Fetcher, fetchPublicUrl } from "../../shared/infrastructure/network-security.ts";
import type { ArtifactPaperIdentity } from "./artifact-paper-identity.ts";

type DiscoveryWarning = NonNullable<ArtifactManifest["discoveryWarnings"]>[number];

interface GitHubRepositoryResult {
	full_name?: unknown;
	name?: unknown;
	html_url?: unknown;
	description?: unknown;
	private?: unknown;
	size?: unknown;
}

interface GitHubRepository {
	fullName: string;
	name: string;
	url: string;
	description: string;
	estimatedBytes?: number;
	queries: string[];
}

export interface GitHubArtifactSearchOptions {
	token?: string;
	signal?: AbortSignal;
	fetcher?: Fetcher;
	resolver?: AddressResolver;
}

function normalized(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function significantWords(value: string): string[] {
	const ignored = new Set([
		"a",
		"an",
		"and",
		"for",
		"from",
		"in",
		"of",
		"on",
		"the",
		"to",
		"toward",
		"towards",
		"with",
	]);
	return normalized(value)
		.split(" ")
		.filter((word) => word.length >= 3 && !ignored.has(word));
}

function projectAliases(title: string): string[] {
	const aliases = new Set<string>();
	const prefix = title.split(/[:\-–—]/, 1)[0]?.trim();
	if (prefix && !prefix.includes(" ") && prefix.length >= 3 && prefix.length <= 40) aliases.add(normalized(prefix));
	for (const match of title.matchAll(/\b[A-Z][A-Z0-9-]{2,}\b/g)) aliases.add(normalized(match[0]));
	return [...aliases].filter(Boolean);
}

export function buildGitHubArtifactQueries(identity: ArtifactPaperIdentity): string[] {
	const queries: string[] = [];
	const projectNames = [
		...(identity.projectNames ?? []).map(normalized),
		...(identity.title ? projectAliases(identity.title) : []),
	].filter(Boolean);
	for (const name of [...new Set(projectNames)].slice(0, 2)) {
		queries.push(`"${name}" in:name,description,readme`);
	}
	const doi = identity.doi ? normalizeDoi(identity.doi) : undefined;
	if (doi) queries.push(`"${doi}" in:readme`);
	if (queries.length < 3 && identity.title) queries.push(`"${identity.title.slice(0, 240)}" in:readme`);
	if (queries.length < 3 && identity.title) {
		const terms = significantWords(identity.title).slice(0, 4).join(" ");
		if (terms) queries.push(`${terms} in:description,readme`);
	}
	return [...new Set(queries)].slice(0, 3);
}

function requestHeaders(token: string | undefined): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

async function githubJson(
	url: URL,
	options: GitHubArtifactSearchOptions,
): Promise<{ value: unknown; response: Response }> {
	if (url.hostname !== "api.github.com") throw new Error("GitHub credentials may only be sent to api.github.com");
	const fetched = await fetchPublicUrl(url, {
		signal: options.signal,
		timeoutMs: 20_000,
		maxRedirects: 0,
		maxRetries: 0,
		requireHttps: true,
		fetcher: options.fetcher,
		resolver: options.resolver,
		init: { headers: requestHeaders(options.token) },
	});
	if (!fetched.response.ok)
		throw Object.assign(new Error(`GitHub API returned HTTP ${fetched.response.status}`), {
			response: fetched.response,
		});
	const body = await readResponseBody(fetched.response, 2 * 1024 * 1024);
	return { value: JSON.parse(body.toString("utf8")) as unknown, response: fetched.response };
}

function parseSearchItems(value: unknown, query: string): GitHubRepository[] {
	if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) return [];
	return ((value as { items: GitHubRepositoryResult[] }).items ?? []).slice(0, 5).flatMap((item) => {
		if (item.private === true || typeof item.full_name !== "string" || typeof item.html_url !== "string") return [];
		if (typeof item.name !== "string" || !/^https:\/\/github\.com\//i.test(item.html_url)) return [];
		return [
			{
				fullName: item.full_name,
				name: item.name,
				url: item.html_url.replace(/\/$/, ""),
				description: typeof item.description === "string" ? item.description : "",
				estimatedBytes: typeof item.size === "number" && item.size >= 0 ? item.size * 1024 : undefined,
				queries: [query],
			},
		];
	});
}

async function readmeFor(repository: GitHubRepository, options: GitHubArtifactSearchOptions): Promise<string> {
	const endpoint = new URL(`https://api.github.com/repos/${repository.fullName}/readme`);
	const result = await githubJson(endpoint, options);
	if (!result.value || typeof result.value !== "object") return "";
	const content = (result.value as { content?: unknown; encoding?: unknown }).content;
	const encoding = (result.value as { encoding?: unknown }).encoding;
	return typeof content === "string" && encoding === "base64"
		? Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8").slice(0, 250_000)
		: "";
}

function authorSurnameMatch(readme: string, authors: string[] | undefined): boolean {
	const haystack = normalized(readme);
	return (authors ?? []).some((author) => {
		const surname = normalized(author).split(" ").at(-1) ?? "";
		return surname.length >= 4 && new RegExp(`\\b${surname}\\b`).test(haystack);
	});
}

function assessRepository(repository: GitHubRepository, readme: string, identity: ArtifactPaperIdentity) {
	const title = identity.title ? normalized(identity.title) : "";
	const combined = normalized(`${repository.description}\n${readme}`);
	const heading = normalized(readme.split(/\r?\n/).slice(0, 12).join(" "));
	const aliases = [
		...(identity.projectNames ?? []).map(normalized),
		...(identity.title ? projectAliases(identity.title) : []),
	];
	const repositoryName = normalized(repository.name);
	const projectMatch = aliases.some((alias) => repositoryName.includes(alias) || heading.includes(alias));
	const exactTitle = title.length >= 8 && combined.includes(title);
	const doi = identity.doi ? normalizeDoi(identity.doi) : undefined;
	const exactDoi = Boolean(doi && combined.includes(normalized(doi)));
	const words = identity.title ? significantWords(identity.title) : [];
	const overlap = words.length ? words.filter((word) => combined.includes(word)).length / words.length : 0;
	const authorMatch = authorSurnameMatch(readme, identity.authors);
	const signals = [
		"github-search",
		...(projectMatch ? ["project-name-match"] : []),
		...(exactTitle ? ["exact-title-match"] : []),
		...(exactDoi ? ["exact-doi-match"] : []),
		...(overlap >= 0.5 ? ["title-keyword-match"] : []),
		...(authorMatch ? ["author-match"] : []),
	];
	if (projectMatch && (exactTitle || exactDoi)) return { confidence: "high" as const, signals };
	if (projectMatch && (overlap >= 0.5 || authorMatch)) return { confidence: "medium" as const, signals };
	return { confidence: "low" as const, signals };
}

function warningFrom(error: unknown, query?: string): DiscoveryWarning {
	const response = error && typeof error === "object" ? (error as { response?: Response }).response : undefined;
	const reset = response?.headers.get("x-ratelimit-reset");
	return {
		source: "github",
		code: response?.status === 403 || response?.status === 429 ? "rate-limited" : "request-failed",
		message: error instanceof Error ? error.message : "GitHub artifact discovery failed",
		query,
		retryAfter: reset && Number.isFinite(Number(reset)) ? new Date(Number(reset) * 1_000).toISOString() : undefined,
	};
}

export async function searchGitHubArtifacts(
	identity: ArtifactPaperIdentity,
	options: GitHubArtifactSearchOptions = {},
) {
	const repositories = new Map<string, GitHubRepository>();
	const warnings: DiscoveryWarning[] = [];
	for (const query of buildGitHubArtifactQueries(identity)) {
		const endpoint = new URL("https://api.github.com/search/repositories");
		endpoint.searchParams.set("q", query);
		endpoint.searchParams.set("per_page", "5");
		try {
			const result = await githubJson(endpoint, options);
			for (const repository of parseSearchItems(result.value, query)) {
				const existing = repositories.get(repository.url);
				if (existing) existing.queries.push(query);
				else repositories.set(repository.url, repository);
			}
		} catch (error) {
			warnings.push(warningFrom(error, query));
		}
	}
	const candidates: ArtifactCandidate[] = [];
	for (const repository of [...repositories.values()].slice(0, 5)) {
		try {
			const readme = await readmeFor(repository, options);
			const assessment = assessRepository(repository, readme, identity);
			candidates.push({
				id: `artifact-${sha256Text(repository.url).slice(0, 16)}`,
				url: repository.url,
				kind: "repository",
				host: "github.com",
				confidence: assessment.confidence,
				relationship: assessment.confidence === "low" ? "unknown" : "artifact-context",
				signals: assessment.signals,
				estimatedBytes: repository.estimatedBytes,
				sources: repository.queries.map((query) => ({
					method: "github-search" as const,
					query,
					url: `https://api.github.com/repos/${repository.fullName}/readme`,
					context: `Verified GitHub README for ${repository.fullName}; ${assessment.signals.join(", ")}`,
					retrievedAt: new Date().toISOString(),
				})),
			});
		} catch (error) {
			warnings.push(warningFrom(error, repository.queries[0]));
		}
	}
	return { candidates, warnings };
}
