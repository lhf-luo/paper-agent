import { canonicalArtifactUrl } from "./artifact-discovery.ts";
import type { ArtifactCandidate, ArtifactManifest } from "./literature-types.ts";

export interface ArtifactGoldEntry {
	id: string;
	urls: string[];
	kind?: ArtifactCandidate["kind"];
	pages?: number[];
	note?: string;
}

export interface ArtifactGoldAnnotation {
	schemaVersion: 1;
	annotationStatus: "human-reviewed" | "machine-generated-candidate";
	source: {
		slug: string;
		title: string;
		paperId?: string;
		pdfPath: string;
		pdfSha256: string;
		sourceUrl: string;
	};
	inspection: {
		allPagesReviewed: boolean;
		pageCount?: number;
		reviewedPages?: number[];
		reviewer?: string;
		reviewedAt?: string;
		notes?: string;
	};
	expectedArtifacts: ArtifactGoldEntry[];
	ignoredUrls: Array<{ url: string; reason: string }>;
	detectorCandidates?: ArtifactCandidate[];
}

export interface ArtifactDiscoveryEvaluation {
	slug: string;
	truePositives: number;
	falsePositives: number;
	falseNegatives: number;
	precision: number;
	recall: number;
	kindCorrect: number;
	kindEvaluated: number;
	pageCorrect: number;
	pageEvaluated: number;
	provenanceComplete: number;
	matchedExpectedIds: string[];
	missingExpectedIds: string[];
	unexpectedUrls: string[];
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 1 : numerator / denominator;
}

function candidateHasCompleteProvenance(candidate: ArtifactCandidate): boolean {
	return (
		candidate.sources.length > 0 &&
		candidate.sources.some(
			(source) =>
				Boolean(source.method) &&
				(Number.isInteger(source.page) || Boolean(source.context?.trim())),
		)
	);
}

export function validateArtifactGoldAnnotation(value: ArtifactGoldAnnotation): void {
	if (value.schemaVersion !== 1) throw new Error("Artifact annotation schemaVersion must be 1");
	if (!value.source?.slug || !value.source.title || !value.source.pdfPath || !value.source.sourceUrl) {
		throw new Error("Artifact annotation source metadata is incomplete");
	}
	if (!/^[a-f0-9]{64}$/i.test(value.source.pdfSha256)) throw new Error("Artifact annotation PDF SHA-256 is invalid");
	if (!Array.isArray(value.expectedArtifacts) || !Array.isArray(value.ignoredUrls)) {
		throw new Error("Artifact annotation expectedArtifacts and ignoredUrls must be arrays");
	}
	const ids = new Set<string>();
	for (const expected of value.expectedArtifacts) {
		if (!expected.id?.trim() || ids.has(expected.id)) throw new Error("Artifact gold ids must be unique and non-empty");
		ids.add(expected.id);
		if (!expected.urls?.length) throw new Error(`Artifact gold ${expected.id} must list at least one accepted URL`);
		for (const url of expected.urls) canonicalArtifactUrl(url);
		if (expected.pages?.some((page) => !Number.isInteger(page) || page < 1)) {
			throw new Error(`Artifact gold ${expected.id} contains an invalid page`);
		}
	}
	for (const ignored of value.ignoredUrls) {
		canonicalArtifactUrl(ignored.url);
		if (!ignored.reason?.trim()) throw new Error("Every ignored artifact URL requires a reason");
	}
	if (value.annotationStatus === "human-reviewed") {
		if (!value.inspection?.allPagesReviewed || !value.inspection.reviewer?.trim()) {
			throw new Error("Human-reviewed artifact annotations must name a reviewer and confirm all pages were inspected");
		}
		if (!Number.isInteger(value.inspection.pageCount) || (value.inspection.pageCount ?? 0) < 1) {
			throw new Error("Human-reviewed artifact annotations require the pinned PDF page count");
		}
		const reviewedPages = value.inspection.reviewedPages;
		if (
			!Array.isArray(reviewedPages) ||
			reviewedPages.length !== value.inspection.pageCount ||
			new Set(reviewedPages).size !== reviewedPages.length ||
			reviewedPages.some((page, index) => page !== index + 1)
		) {
			throw new Error("Human-reviewed artifact annotations must explicitly list every inspected physical page");
		}
		if (!value.inspection.reviewedAt || !Number.isFinite(Date.parse(value.inspection.reviewedAt))) {
			throw new Error("Human-reviewed artifact annotations require a valid reviewedAt timestamp");
		}
	}
}

export function evaluateArtifactDiscovery(
	annotation: ArtifactGoldAnnotation,
	manifest: ArtifactManifest,
): ArtifactDiscoveryEvaluation {
	validateArtifactGoldAnnotation(annotation);
	if (manifest.pdfSha256 !== annotation.source.pdfSha256) {
		throw new Error(`PDF SHA-256 changed for ${annotation.source.slug}`);
	}
	const ignored = new Set(annotation.ignoredUrls.map((item) => canonicalArtifactUrl(item.url)));
	const predictions = manifest.candidates
		.map((candidate) => ({ candidate, url: canonicalArtifactUrl(candidate.url) }))
		.filter((item) => !ignored.has(item.url));
	const used = new Set<number>();
	const matchedExpectedIds: string[] = [];
	const missingExpectedIds: string[] = [];
	let kindCorrect = 0;
	let kindEvaluated = 0;
	let pageCorrect = 0;
	let pageEvaluated = 0;
	let provenanceComplete = 0;

	for (const expected of annotation.expectedArtifacts) {
		const accepted = new Set(expected.urls.map((url) => canonicalArtifactUrl(url)));
		const index = predictions.findIndex((prediction, candidateIndex) => !used.has(candidateIndex) && accepted.has(prediction.url));
		if (index < 0) {
			missingExpectedIds.push(expected.id);
			continue;
		}
		used.add(index);
		matchedExpectedIds.push(expected.id);
		const candidate = predictions[index].candidate;
		if (expected.kind) {
			kindEvaluated++;
			if (candidate.kind === expected.kind) kindCorrect++;
		}
		if (expected.pages?.length) {
			pageEvaluated++;
			if (candidate.sources.some((source) => source.page && expected.pages?.includes(source.page))) pageCorrect++;
		}
		if (candidateHasCompleteProvenance(candidate)) provenanceComplete++;
	}

	const unexpectedUrls = predictions.filter((_prediction, index) => !used.has(index)).map((item) => item.url);
	const truePositives = used.size;
	const falsePositives = unexpectedUrls.length;
	const falseNegatives = annotation.expectedArtifacts.length - truePositives;
	return {
		slug: annotation.source.slug,
		truePositives,
		falsePositives,
		falseNegatives,
		precision: ratio(truePositives, truePositives + falsePositives),
		recall: ratio(truePositives, truePositives + falseNegatives),
		kindCorrect,
		kindEvaluated,
		pageCorrect,
		pageEvaluated,
		provenanceComplete,
		matchedExpectedIds,
		missingExpectedIds,
		unexpectedUrls,
	};
}
