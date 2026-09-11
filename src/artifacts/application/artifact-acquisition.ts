import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	ArtifactCandidate,
	ArtifactManifest,
	ArtifactSnapshot,
	ArtifactSourceFile,
	ArtifactSourceMetadata,
} from "../../literature/domain/literature-types.ts";
import {
	authorizeOperationExecution,
	type OperationExecutionAuthorization,
	type OperationPlan,
} from "../../shared/application/operation-consent.ts";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { readableErrorMessage } from "../../shared/infrastructure/network-errors.ts";
import { acquisitionRoot, atomicJson, exists, readExistingManifest } from "./artifact-acquisition-files.ts";
import { type ArtifactNetworkOptions, resolveArtifactSourceMetadata } from "./artifact-content.ts";
import {
	downloadArtifact,
	isMetadataLandingPage,
	metadataFileCandidate,
	resolveDoiCandidate,
} from "./artifact-download-acquisition.ts";
import { cloneRepository, validateExistingSnapshot } from "./artifact-git-acquisition.ts";
import { validateArtifactByteLimit } from "./artifact-limits.ts";

export async function acquireArtifacts(
	pi: CommandExecutor,
	manifest: ArtifactManifest,
	options: {
		candidateIds?: string[];
		maxArtifacts: number;
		maxBytesPerArtifact: number;
		signal?: AbortSignal;
		fetcher?: ArtifactNetworkOptions["fetcher"];
		resolver?: ArtifactNetworkOptions["resolver"];
		authorization: OperationExecutionAuthorization;
	},
): Promise<{
	manifest: ArtifactManifest;
	manifestPath: string;
	root: string;
	attemptAcquisitions: ArtifactSnapshot[];
}> {
	if (!Number.isInteger(options.maxArtifacts) || options.maxArtifacts < 1) {
		throw new Error("maxArtifacts must be a positive integer");
	}
	validateArtifactByteLimit(options.maxBytesPerArtifact);
	const selected = selectArtifactCandidates(manifest, options.candidateIds);
	assertArtifactSelection(manifest, options.candidateIds, selected);
	await authorizeOperationExecution(
		options.authorization,
		artifactAcquisitionPlan(manifest, {
			candidateIds: options.candidateIds,
			maxArtifacts: options.maxArtifacts,
			maxBytesPerArtifact: options.maxBytesPerArtifact,
		}),
	);
	const root = acquisitionRoot(manifest);
	await mkdir(root, { recursive: true });
	const manifestPath = join(root, "artifact-manifest.json");
	const existingManifest = await readExistingManifest(manifestPath, manifest.pdfSha256);
	const acquisitions: ArtifactSnapshot[] = [];
	const candidates = [...manifest.candidates];
	for (const selectedCandidate of selected) {
		if (acquisitions.length >= options.maxArtifacts) break;
		let effectiveCandidate = selectedCandidate;
		let metadata: ArtifactSourceMetadata | undefined;
		let metadataError: string | undefined;
		try {
			if (selectedCandidate.host.toLowerCase() === "doi.org") {
				effectiveCandidate = await resolveDoiCandidate(selectedCandidate, {
					signal: options.signal,
					fetcher: options.fetcher,
					resolver: options.resolver,
				});
				if (!candidates.some((candidate) => candidate.id === effectiveCandidate.id)) {
					candidates.push(effectiveCandidate);
				}
			}
			metadata = await resolveArtifactSourceMetadata(effectiveCandidate, {
				signal: options.signal,
				fetcher: options.fetcher,
				resolver: options.resolver,
			});
		} catch (error) {
			metadataError = readableErrorMessage(error);
		}
		let acquisitionCandidates: Array<{ candidate: ArtifactCandidate; metadataFile?: ArtifactSourceFile }> = [
			{ candidate: effectiveCandidate },
		];
		if (metadata && isMetadataLandingPage(effectiveCandidate, metadata)) {
			acquisitionCandidates = (metadata.files ?? []).map((file) => ({
				candidate: metadataFileCandidate(effectiveCandidate, file),
				metadataFile: file,
			}));
			for (const item of acquisitionCandidates) {
				if (!candidates.some((candidate) => candidate.id === item.candidate.id)) candidates.push(item.candidate);
			}
			if (acquisitionCandidates.length === 0) {
				acquisitions.push({
					candidateId: selectedCandidate.id,
					sourceUrl: selectedCandidate.url,
					status: "failed",
					retrievedAt: new Date().toISOString(),
					metadata,
					failureReason: "artifact metadata record exposes no downloadable files",
				});
				continue;
			}
		}
		for (const { candidate, metadataFile } of acquisitionCandidates) {
			if (acquisitions.length >= options.maxArtifacts) break;
			try {
				const previous = existingManifest?.acquisitions
					.filter(
						(snapshot) =>
							snapshot.candidateId === candidate.id &&
							(snapshot.status === "downloaded" ||
								snapshot.status === "cloned" ||
								snapshot.status === "skipped"),
					)
					.at(-1);
				if (previous) {
					const validation = await validateExistingSnapshot(pi, previous, root, options.signal);
					if (validation.valid) {
						acquisitions.push({
							...previous,
							...validation.evidence,
							status: "skipped",
							retrievedAt: new Date().toISOString(),
							failureReason:
								"reused integrity-verified provenance snapshot without repeated network acquisition",
						});
						continue;
					}
					if (previous.localPath && (await exists(previous.localPath))) {
						acquisitions.push({
							candidateId: candidate.id,
							sourceUrl: candidate.url,
							status: "failed",
							localPath: previous.localPath,
							retrievedAt: new Date().toISOString(),
							failureReason: `refused to reuse existing snapshot: ${validation.reason ?? "integrity validation failed"}`,
						});
						continue;
					}
				}
				const snapshot =
					candidate.kind === "repository"
						? await cloneRepository(
								pi,
								candidate,
								root,
								options.maxBytesPerArtifact,
								metadata,
								metadataError,
								options.signal,
								{
									fetcher: options.fetcher,
									resolver: options.resolver,
								},
							)
						: await downloadArtifact(
								candidate,
								root,
								options.maxBytesPerArtifact,
								metadata,
								metadataError,
								metadataFile,
								options.signal,
								{ fetcher: options.fetcher, resolver: options.resolver },
							);
				acquisitions.push(snapshot);
			} catch (error) {
				acquisitions.push({
					candidateId: candidate.id,
					sourceUrl: candidate.url,
					status: "failed",
					retrievedAt: new Date().toISOString(),
					failureReason: readableErrorMessage(error),
				});
			}
		}
	}
	const updated: ArtifactManifest = {
		...manifest,
		candidates,
		acquisitions: [...(existingManifest?.acquisitions ?? manifest.acquisitions), ...acquisitions],
	};
	await atomicJson(manifestPath, updated);
	return { manifest: updated, manifestPath, root, attemptAcquisitions: acquisitions };
}

export function artifactAcquisitionPlan(
	manifest: ArtifactManifest,
	options: { candidateIds?: string[]; maxArtifacts: number; maxBytesPerArtifact: number },
): OperationPlan {
	validateArtifactByteLimit(options.maxBytesPerArtifact);
	const selected = selectArtifactCandidates(manifest, options.candidateIds);
	assertArtifactSelection(manifest, options.candidateIds, selected);
	return {
		kind: "artifact-acquisition",
		summary: `Acquire up to ${options.maxArtifacts} artifacts discovered in ${manifest.pdfPath}`,
		targets: selected.slice(0, options.maxArtifacts).map((candidate) => ({
			label: `${candidate.kind}:${candidate.id}`,
			value: candidate.url,
			risk: candidate.confidence === "low" ? "high" : "medium",
		})),
		details: {
			pdfPath: manifest.pdfPath,
			pdfSha256: manifest.pdfSha256,
			candidateIds: selected.map((candidate) => candidate.id).sort(),
			maxArtifacts: options.maxArtifacts,
			maxBytesPerArtifact: options.maxBytesPerArtifact,
			excludedLowConfidenceCount:
				options.candidateIds === undefined
					? manifest.candidates.filter(
							(candidate) => !candidate.parentCandidateId && !isDefaultAcquisitionCandidate(candidate),
						).length
					: 0,
		},
	};
}

export function selectArtifactCandidates(manifest: ArtifactManifest, candidateIds?: string[]): ArtifactCandidate[] {
	if (candidateIds !== undefined) {
		return manifest.candidates.filter((candidate) => candidateIds.includes(candidate.id));
	}
	return manifest.candidates.filter(
		(candidate) => !candidate.parentCandidateId && isDefaultAcquisitionCandidate(candidate),
	);
}

function isDefaultAcquisitionCandidate(candidate: ArtifactCandidate): boolean {
	const githubFallback = candidate.sources.some((source) => source.method === "github-search");
	return (
		candidate.confidence !== "low" &&
		(!githubFallback || candidate.confidence === "high") &&
		candidate.relationship !== "third-party" &&
		candidate.relationship !== "citation-only"
	);
}

export function assertArtifactSelection(
	manifest: ArtifactManifest,
	candidateIds?: string[],
	selected = selectArtifactCandidates(manifest, candidateIds),
): void {
	if (manifest.candidates.length === 0 || selected.length > 0) return;
	if (candidateIds === undefined) {
		throw new Error(
			"Only low-confidence, citation-only, or third-party artifact candidates were discovered. Review the evidence and pass the intended candidate_ids explicitly.",
		);
	}
	throw new Error("Select at least one discovered artifact candidate before acquisition");
}
