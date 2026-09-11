import type { ArtifactCandidate } from "../../literature/domain/literature-types.ts";

export function requestedGitRefs(candidate: ArtifactCandidate): string[] {
	const sourceUrl = [
		candidate.url,
		...candidate.sources.map((source) => source.url).filter((url): url is string => Boolean(url)),
	]
		.flatMap((value) => {
			try {
				return [new URL(value)];
			} catch {
				return [];
			}
		})
		.find((url) => {
			const parts = url.pathname.split("/").filter(Boolean);
			return url.hostname.toLowerCase() === "github.com"
				? ["commit", "releases", "tree"].includes(parts[2] ?? "")
				: url.hostname.toLowerCase() === "gitlab.com" && parts.includes("-");
		});
	const url = sourceUrl ?? new URL(candidate.url);
	const host = url.hostname.toLowerCase();
	const parts = url.pathname.split("/").filter(Boolean);
	let value: string | undefined;
	let treeReference = false;
	if (host === "github.com") {
		if (parts[2] === "commit" && parts[3]) value = parts[3];
		else if (parts[2] === "releases" && parts[3] === "tag" && parts[4]) value = parts.slice(4).join("/");
		else if (parts[2] === "tree" && parts[3]) {
			value = parts.slice(3).join("/");
			treeReference = true;
		}
	} else if (host === "gitlab.com") {
		const marker = parts.indexOf("-");
		const action = marker >= 0 ? parts[marker + 1] : undefined;
		if (action === "commit" && parts[marker + 2]) value = parts[marker + 2];
		else if ((action === "tree" || action === "tags") && parts[marker + 2]) {
			value = parts.slice(marker + 2).join("/");
			treeReference = action === "tree";
		}
	} else return [];
	if (!value) return [];
	const decoded = decodeURIComponent(value);
	if (
		decoded.length > 200 ||
		decoded.startsWith("-") ||
		decoded.includes("..") ||
		/[\u0000-\u0020~^:?*\\[\]]/.test(decoded)
	) {
		throw new Error("Git reference in artifact URL is unsafe or malformed");
	}
	if (!treeReference) return [decoded];
	const segments = decoded.split("/");
	return segments.map((_, index) => segments.slice(0, segments.length - index).join("/"));
}
