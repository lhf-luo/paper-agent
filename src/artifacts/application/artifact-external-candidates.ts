import { sha256Text } from "../../literature/domain/literature-identifiers.ts";
import type { ArtifactCandidate, ArtifactManifest } from "../../literature/domain/literature-types.ts";
import {
	canonicalArtifactUrl,
	classifyArtifactUrl,
	knownArtifactHosts,
	normalizeCandidateUrl,
} from "./artifact-discovery.ts";

type DiscoveryWarning = NonNullable<ArtifactManifest["discoveryWarnings"]>[number];

export function externalArtifactCandidates(urls: string[] | undefined): {
	candidates: ArtifactCandidate[];
	warnings: DiscoveryWarning[];
} {
	const candidates = new Map<string, ArtifactCandidate>();
	const warnings: DiscoveryWarning[] = [];
	for (const raw of [...new Set(urls ?? [])].slice(0, 20)) {
		const url = normalizeCandidateUrl(raw);
		const host = url?.hostname.toLowerCase().replace(/^www\./, "");
		if (!url || url.protocol !== "https:" || !host || !knownArtifactHosts.has(host)) {
			warnings.push({
				source: "external-url",
				code: "unsupported-url",
				message: `Ignored unsupported artifact URL: ${raw}`,
			});
			continue;
		}
		const canonical = canonicalArtifactUrl(url);
		candidates.set(canonical, {
			id: `artifact-${sha256Text(canonical).slice(0, 16)}`,
			url: canonical,
			kind: classifyArtifactUrl(url),
			host,
			confidence: "medium",
			relationship: "artifact-context",
			signals: ["explicit-external-url"],
			sources: [
				{
					method: "external-url",
					url: url.href,
					context: "Explicitly supplied artifact candidate URL",
					retrievedAt: new Date().toISOString(),
				},
			],
		});
	}
	return { candidates: [...candidates.values()], warnings };
}
