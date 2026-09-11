import type { PaperRecord } from "../../literature/domain/literature-types.ts";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import type { AddressResolver } from "../../shared/infrastructure/network-address.ts";
import type { Fetcher } from "../../shared/infrastructure/network-security.ts";
import { discoverArtifactsFromPdf, mergeArtifactCandidates } from "./artifact-discovery.ts";
import { externalArtifactCandidates } from "./artifact-external-candidates.ts";
import { searchGitHubArtifacts } from "./artifact-github-search.ts";
import type { ArtifactPaperIdentity } from "./artifact-paper-identity.ts";

export interface PaperArtifactDiscoveryOptions {
	signal?: AbortSignal;
	sourceDirectory?: string;
	paper?: Pick<PaperRecord, "title" | "authors" | "identifiers">;
	additionalCandidateUrls?: string[];
	githubToken?: string;
	fetcher?: Fetcher;
	resolver?: AddressResolver;
}

function identityFromPaper(options: PaperArtifactDiscoveryOptions): ArtifactPaperIdentity | undefined {
	if (!options.paper) return undefined;
	return {
		title: options.paper.title,
		authors: options.paper.authors,
		doi: options.paper.identifiers.doi,
	};
}

function discoveryIdentity(
	options: PaperArtifactDiscoveryOptions,
	pdfIdentity: ArtifactPaperIdentity | undefined,
): ArtifactPaperIdentity | undefined {
	const stored = identityFromPaper(options);
	if (!stored) return pdfIdentity;
	return {
		...pdfIdentity,
		...stored,
		projectNames: pdfIdentity?.projectNames,
	};
}

function isCredibleOwnArtifact(candidate: { confidence: "high" | "medium" | "low"; relationship?: string }): boolean {
	return (
		candidate.confidence !== "low" &&
		candidate.relationship !== "citation-only" &&
		candidate.relationship !== "third-party"
	);
}

export async function discoverPaperArtifacts(
	executor: CommandExecutor,
	pdfPath: string,
	options: PaperArtifactDiscoveryOptions = {},
) {
	const pdfManifest = await discoverArtifactsFromPdf(executor, pdfPath, options.signal, options.sourceDirectory);
	const external = externalArtifactCandidates(options.additionalCandidateUrls);
	const identity = discoveryIdentity(options, pdfManifest.paperIdentity);
	const github =
		!pdfManifest.candidates.some(isCredibleOwnArtifact) &&
		identity &&
		(identity.title || identity.doi || identity.projectNames?.length)
			? await searchGitHubArtifacts(identity, {
					token: options.githubToken,
					signal: options.signal,
					fetcher: options.fetcher,
					resolver: options.resolver,
				})
			: { candidates: [], warnings: [] };
	return {
		...pdfManifest,
		paperIdentity: identity,
		candidates: mergeArtifactCandidates([pdfManifest.candidates, external.candidates, github.candidates]),
		discoveryWarnings: [...external.warnings, ...github.warnings],
	};
}
