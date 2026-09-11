import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizePreparedAgentOperation } from "../../app/presentation/interactive-operation-consent.ts";
import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../literature/application/literature-store.ts";
import type { ArtifactManifest, PaperRecord } from "../../literature/domain/literature-types.ts";
import { validatePdfPath } from "../../pdf/application/pdf-document.ts";
import { OperationConsentManager } from "../../shared/application/operation-consent.ts";
import {
	acquireArtifacts,
	artifactAcquisitionPlan,
	assertArtifactSelection,
} from "../application/artifact-acquisition.ts";
import {
	artifactByteLimit,
	DEFAULT_ARTIFACT_MEGABYTES,
	MAX_ARTIFACT_MEGABYTES,
} from "../application/artifact-limits.ts";
import { discoverPaperArtifacts } from "../application/paper-artifact-discovery.ts";

interface ToolContext {
	cwd: string;
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

async function discoveryContext(
	params: { paper_id?: string; namespace?: string; corpus_root?: string },
	cwd: string,
): Promise<{ namespace: string; store?: LiteratureStore; paper?: PaperRecord; githubToken?: string }> {
	const namespace = params.namespace ?? "default";
	const store = params.paper_id
		? new LiteratureStore(resolveCorpusRoot(cwd, "personal", namespace, params.corpus_root), "personal", namespace)
		: undefined;
	const paper = params.paper_id ? await store?.getPaper(params.paper_id) : undefined;
	if (params.paper_id && !paper) throw new Error(`Paper not found in personal corpus: ${params.paper_id}`);
	const config = await loadPaperAgentConfig(cwd);
	return { namespace, store, paper, githubToken: config.credentials?.githubToken };
}

function discoveryParameters() {
	return {
		pdf_path: Type.String({ description: "Paper PDF path" }),
		source_directory: Type.Optional(Type.String({ description: "Extracted LaTeX source directory" })),
		paper_id: Type.Optional(Type.String({ description: "Personal-library paper used for title, authors, and DOI" })),
		namespace: Type.Optional(Type.String({ description: "Personal-library namespace; default: default" })),
		corpus_root: Type.Optional(Type.String()),
		additional_candidate_urls: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
	};
}

async function discoverForTool(
	pi: ExtensionAPI,
	params: {
		pdf_path: string;
		source_directory?: string;
		paper_id?: string;
		namespace?: string;
		corpus_root?: string;
		additional_candidate_urls?: string[];
	},
	signal: AbortSignal | undefined,
	cwd: string,
) {
	const pdfPath = await validatePdfPath(params.pdf_path, cwd);
	const context = await discoveryContext(params, cwd);
	const manifest = await discoverPaperArtifacts(pi, pdfPath, {
		signal,
		sourceDirectory: params.source_directory ? resolve(cwd, params.source_directory) : undefined,
		paper: context.paper,
		additionalCandidateUrls: params.additional_candidate_urls,
		githubToken: context.githubToken,
	});
	return { pdfPath, manifest, ...context };
}

function formatDiscovery(manifest: ArtifactManifest): string {
	return [
		`Paper: ${manifest.pdfPath}`,
		`PDF SHA-256: ${manifest.pdfSha256}`,
		`Artifact candidates: ${manifest.candidates.length}`,
		...manifest.candidates.map((candidate) =>
			[
				`- ${candidate.id} [${candidate.kind}/${candidate.confidence}/${candidate.relationship ?? "unknown"}] ${candidate.url}`,
				candidate.estimatedBytes ? `  estimated_bytes=${candidate.estimatedBytes}` : "",
				candidate.signals?.length ? `  signals=${candidate.signals.join(",")}` : "",
				...candidate.sources.map(
					(source) =>
						`  source=${source.method}${source.page ? ` page=${source.page}` : ""}${source.query ? ` query=${source.query}` : ""}${source.context ? ` context=${source.context}` : ""}`,
				),
			]
				.filter(Boolean)
				.join("\n"),
		),
		...(manifest.discoveryWarnings ?? []).map((warning) => `Warning [${warning.code}]: ${warning.message}`),
		manifest.candidates.length === 0 ? "No artifact candidates were found in the PDF or GitHub fallback search." : "",
	].join("\n");
}

function acquisitionText(acquired: Awaited<ReturnType<typeof acquireArtifacts>>, persistedManifestId?: string): string {
	const failures = acquired.attemptAcquisitions.filter((snapshot) => snapshot.status === "failed");
	return [
		`Artifact root: ${acquired.root}`,
		`Manifest: ${acquired.manifestPath}`,
		persistedManifestId ? `SQLite manifest: ${persistedManifestId}` : "",
		`Acquisition records: ${acquired.attemptAcquisitions.length}; failures: ${failures.length}`,
		...acquired.attemptAcquisitions.map((snapshot) => {
			const excluded = snapshot.excludedCheckoutPaths ?? [];
			const excludedSummary = excluded.length
				? `${excluded.length} (${excluded.slice(0, 5).join(", ")}${excluded.length > 5 ? ", ..." : ""})`
				: "none";
			return `- ${snapshot.candidateId}: ${snapshot.status}\n  source=${snapshot.sourceUrl}\n  local=${snapshot.localPath ?? "none"}\n  commit=${snapshot.commit ?? "none"}\n  excluded_windows_paths=${excludedSummary}\n  note=${snapshot.failureReason ?? "none"}`;
		}),
	]
		.filter(Boolean)
		.join("\n");
}

function registerDiscoveryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "discover_paper_artifacts",
		label: "Discover paper artifacts",
		description:
			"Discover repositories, datasets, supplements, and project pages from a PDF. If the PDF has no credible paper-owned artifact, bounded GitHub API searches prioritize tool or project names extracted from the paper, then DOI and title fallback. Explicit supported HTTPS URLs can be added as candidates.",
		promptSnippet: "Discover paper artifacts with PDF-first GitHub fallback",
		promptGuidelines: [
			"Always pass paper_id and namespace when the paper is in the personal library so stored metadata overrides PDF headers and the completed manifest remains associated with that paper.",
			"Prefer tool names and project acronyms stated by the paper (for example MLTA, TypeDive, or RTT) over the full paper title when checking GitHub.",
			"If deterministic discovery finds no credible candidate, model memory may suggest an untrusted lead only after the lead is verified on a public GitHub README, author organization page, paper title, DOI, or author evidence.",
			"Use additional_candidate_urls for a URL found in public evidence; never pass a raw URL as candidate_ids.",
			"Treat only candidates with recorded PDF, GitHub API/README, or external URL provenance as discoverable artifacts.",
		],
		parameters: Type.Object(discoveryParameters()),
		async execute(_id, params, signal, _update, ctx) {
			const discovered = await discoverForTool(pi, params, signal, ctx.cwd);
			return {
				content: [{ type: "text", text: formatDiscovery(discovered.manifest) }],
				details: discovered.manifest,
			};
		},
	});
}

function registerAcquisitionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "acquire_paper_artifacts",
		label: "Acquire paper artifacts",
		description:
			"Discover and safely acquire selected artifacts. Git repositories use bounded shallow clones; other supported HTTPS artifacts are size-bounded and validated. Nothing is executed or automatically extracted.",
		promptSnippet: "Safely acquire verified paper artifacts with provenance",
		promptGuidelines: [
			"GitHub fallback runs automatically when the PDF has no credible paper-owned artifact. High-confidence matches are selected by default; medium and low GitHub matches require candidate_ids.",
			"For saved papers, always pass paper_id and namespace; do not repeat discovery with only a PDF path.",
			"Use additional_candidate_urls for externally verified repository or artifact URLs, then review the exact confirmation manifest.",
			"Always disclose failures, the exact commit, local path, and license uncertainty.",
		],
		parameters: Type.Object({
			...discoveryParameters(),
			candidate_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
			max_artifacts: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default: 10" })),
			max_megabytes_per_artifact: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_ARTIFACT_MEGABYTES,
					description: `Default: ${DEFAULT_ARTIFACT_MEGABYTES}`,
				}),
			),
		}),
		async execute(_id, params, signal, _update, ctx: ToolContext) {
			const discovered = await discoverForTool(pi, params, signal, ctx.cwd);
			const unknown = (params.candidate_ids ?? []).filter(
				(id) => !discovered.manifest.candidates.some((item) => item.id === id),
			);
			if (unknown.length) throw new Error(`Unknown artifact candidate ids: ${unknown.join(", ")}`);
			assertArtifactSelection(discovered.manifest, params.candidate_ids);
			const options = {
				candidateIds: params.candidate_ids,
				maxArtifacts: params.max_artifacts ?? 10,
				maxBytesPerArtifact: artifactByteLimit(params.max_megabytes_per_artifact),
			};
			const consent = new OperationConsentManager({
				auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
				signingKeyPath: resolve(ctx.cwd, ".paper-agent", "runtime", "operation-signing.key"),
			});
			const prepared = await consent.prepare(artifactAcquisitionPlan(discovered.manifest, options));
			const grant = await authorizePreparedAgentOperation(ctx, consent, prepared, {
				title: "Acquire paper artifacts?",
				unavailableMessage: "Artifact acquisition requires interactive user confirmation",
				details: () => [
					`Maximum bytes per artifact: ${options.maxBytesPerArtifact}`,
					"Downloaded content will not be executed or automatically extracted.",
				],
			});
			const acquired = await acquireArtifacts(pi, discovered.manifest, {
				...options,
				signal,
				authorization: { manager: consent, grant },
			});
			const persisted = discovered.store
				? await discovered.store.saveArtifactManifest(acquired.manifest, params.paper_id)
				: undefined;
			const failures = acquired.attemptAcquisitions.filter((snapshot) => snapshot.status === "failed");
			if (acquired.attemptAcquisitions.length && failures.length === acquired.attemptAcquisitions.length)
				throw new Error(
					`All selected artifact acquisitions failed. Manifest: ${acquired.manifestPath}. ${failures.map((item) => item.failureReason ?? "unknown failure").join("; ")}`,
				);
			return {
				content: [{ type: "text", text: acquisitionText(acquired, persisted) }],
				details: {
					path: discovered.pdfPath,
					artifactRoot: acquired.root,
					manifestPath: acquired.manifestPath,
					persistedManifestId: persisted,
					acquisitions: acquired.attemptAcquisitions,
					failures: failures.map((item) => item.failureReason),
				},
			};
		},
	});
}

export function registerArtifactDiscoveryTools(pi: ExtensionAPI): void {
	registerDiscoveryTool(pi);
	registerAcquisitionTool(pi);
}
