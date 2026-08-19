import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { acquireArtifacts, artifactAcquisitionPlan, assertArtifactSelection } from "../artifact-acquisition.ts";
import { discoverArtifactsFromPdf } from "../artifact-discovery.ts";
import { OperationConsentManager } from "../operation-consent.ts";
import { validatePdfPath } from "./pdf-tools.ts";

interface ArtifactEntry {
	path: string;
	kind: "directory" | "file" | "symlink";
	size?: number;
}

interface RepositoryEvidence {
	path: string;
	commit?: string;
	remote?: string;
	dirty: boolean;
}

interface ArtifactDetails {
	root: string;
	entryCount: number;
	repositories: RepositoryEvidence[];
	truncated: boolean;
}

const skippedDirectories = new Set([
	".cache",
	".git",
	".hg",
	".mypy_cache",
	".next",
	".pytest_cache",
	".tox",
	".venv",
	".svn",
	"__pycache__",
	"build",
	"dist",
	"node_modules",
	"target",
	"venv",
]);

async function collectArtifacts(root: string, maxDepth: number, maxEntries: number) {
	const entries: ArtifactEntry[] = [];
	const repositories = new Set<string>();
	const pending: Array<{ absolutePath: string; depth: number }> = [{ absolutePath: root, depth: 0 }];

	while (pending.length > 0 && entries.length < maxEntries) {
		const current = pending.shift();
		if (!current) break;
		let children: Dirent[];
		try {
			children = await readdir(current.absolutePath, { withFileTypes: true });
		} catch {
			continue;
		}
		children.sort((left, right) => left.name.localeCompare(right.name));

		for (const child of children) {
			if (entries.length >= maxEntries) break;
			const absolutePath = join(current.absolutePath, child.name);
			const displayPath = relative(root, absolutePath) || ".";
			if (child.name === ".git") {
				repositories.add(current.absolutePath);
				entries.push({ path: `${displayPath}/`, kind: "directory" });
				continue;
			}
			if (child.isDirectory()) {
				entries.push({ path: `${displayPath}/`, kind: "directory" });
				if (current.depth < maxDepth && !skippedDirectories.has(child.name)) {
					pending.push({ absolutePath, depth: current.depth + 1 });
				}
				continue;
			}
			if (child.isSymbolicLink()) {
				entries.push({ path: displayPath, kind: "symlink" });
				continue;
			}
			let size: number | undefined;
			try {
				size = (await stat(absolutePath)).size;
			} catch {
				size = undefined;
			}
			entries.push({ path: displayPath, kind: "file", size });
		}
	}
	return { entries, repositories: [...repositories] };
}

async function inspectRepository(pi: ExtensionAPI, path: string, signal?: AbortSignal): Promise<RepositoryEvidence> {
	const [commitResult, remoteResult, statusResult] = await Promise.all([
		pi.exec("git", ["-C", path, "rev-parse", "HEAD"], { signal, timeout: 10_000 }),
		pi.exec("git", ["-C", path, "remote", "get-url", "origin"], { signal, timeout: 10_000 }),
		pi.exec("git", ["-C", path, "status", "--short"], { signal, timeout: 10_000 }),
	]);
	return {
		path,
		commit: commitResult.code === 0 ? commitResult.stdout.trim() : undefined,
		remote: remoteResult.code === 0 ? remoteResult.stdout.trim() : undefined,
		dirty: statusResult.code === 0 && statusResult.stdout.trim().length > 0,
	};
}

function formatEntry(entry: ArtifactEntry): string {
	if (entry.kind === "directory") return `[dir]  ${entry.path}`;
	if (entry.kind === "symlink") return `[link] ${entry.path}`;
	return `[file] ${entry.path}${entry.size === undefined ? "" : ` (${formatSize(entry.size)})`}`;
}

export function registerArtifactTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "discover_paper_artifacts",
		label: "Discover paper artifacts",
		description:
			"Read PDF URL annotations and extracted text to discover code repositories, datasets, supplements, and project pages. This is read-only and reports page/context provenance for every candidate.",
		promptSnippet: "Discover artifact links embedded in a paper PDF",
		promptGuidelines: [
			"Run discovery before acquisition. Review low-confidence candidates and disclose when no artifact link is found.",
			"Do not treat a discovered URL as proof that its contents match the paper until the acquired snapshot is inspected.",
		],
		parameters: Type.Object({
			pdf_path: Type.String({ description: "Paper PDF path" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pdfPath = await validatePdfPath(params.pdf_path, ctx.cwd);
			const manifest = await discoverArtifactsFromPdf(pi, pdfPath, signal);
			const text = [
				"Paper: " + pdfPath,
				"PDF SHA-256: " + manifest.pdfSha256,
				"Artifact candidates: " + manifest.candidates.length,
				"",
				...manifest.candidates.map((candidate) =>
					[
						"- " + candidate.id + " [" + candidate.kind + "/" + candidate.confidence + "] " + candidate.url,
						...candidate.sources.map(
							(source) =>
								"  source=" +
								source.method +
								(source.page ? " page=" + source.page : "") +
								(source.context ? " context=" + source.context : ""),
						),
					].join("\n"),
				),
				manifest.candidates.length === 0
					? "No artifact links were found in PDF annotations or extracted text."
					: "",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					path: pdfPath,
					pdfSha256: manifest.pdfSha256,
					candidateCount: manifest.candidates.length,
					candidates: manifest.candidates,
					failures: [],
				},
			};
		},
	});

	pi.registerTool({
		name: "acquire_paper_artifacts",
		label: "Acquire paper artifacts",
		description:
			"Discover and safely acquire selected paper artifacts. Public HTTPS Git repositories are shallow-cloned without submodules or LFS smudging, paper-specified Git refs are resolved when present, and supported host metadata is recorded. Other public HTTPS files are size-bounded, MIME/magic checked, and atomically written. Nothing is executed or auto-extracted. A provenance manifest records URLs, redirects, commits, hashes, content validation, license hints, skips, and failures.",
		promptSnippet: "Safely download or clone discovered paper artifacts with provenance",
		promptGuidelines: [
			"Run only after discovery. Without candidate_ids, only high- and medium-confidence candidates are acquired; low-confidence citation-only links require explicit candidate_ids. Never execute acquired code automatically.",
			"Inspect artifact-manifest.json and disclose all acquisition failures, reused paths, exact commits, and license uncertainty.",
		],
		parameters: Type.Object({
			pdf_path: Type.String({ description: "Paper PDF path" }),
			candidate_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
			max_artifacts: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default: 10" })),
			max_megabytes_per_artifact: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 200, description: "Default: 50" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pdfPath = await validatePdfPath(params.pdf_path, ctx.cwd);
			const discovered = await discoverArtifactsFromPdf(pi, pdfPath, signal);
			const unknownIds = (params.candidate_ids ?? []).filter(
				(id) => !discovered.candidates.some((candidate) => candidate.id === id),
				);
				if (unknownIds.length) throw new Error("Unknown artifact candidate ids: " + unknownIds.join(", "));
				assertArtifactSelection(discovered, params.candidate_ids);
			if (!ctx.hasUI) {
				throw new Error(
					"Artifact acquisition requires an interactive user confirmation. Use the Paper Agent UI or an interactive Pi session.",
				);
			}
			const acquisitionOptions = {
				candidateIds: params.candidate_ids,
				maxArtifacts: params.max_artifacts ?? 10,
				maxBytesPerArtifact: (params.max_megabytes_per_artifact ?? 50) * 1024 * 1024,
			};
			const consent = new OperationConsentManager({
				auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
			});
			const plan = artifactAcquisitionPlan(discovered, acquisitionOptions);
			const prepared = await consent.prepare(plan);
			const confirmed = await ctx.ui.confirm(
				"Acquire paper artifacts?",
				[
					prepared.summary,
					`Manifest: ${prepared.manifestFingerprint}`,
					`Maximum bytes per artifact: ${acquisitionOptions.maxBytesPerArtifact}`,
					...prepared.targets.map((target) => `- [${target.risk ?? "medium"}] ${target.value}`),
					"Downloaded content will not be executed or automatically extracted.",
				].join("\n"),
			);
			if (!confirmed) {
				await consent.cancel(prepared.operationId);
				throw new Error("Artifact acquisition was cancelled by the user");
			}
			const grant = await consent.confirm(prepared.operationId, prepared.manifestFingerprint, "interactive-user");
			const acquired = await acquireArtifacts(pi, discovered, {
				...acquisitionOptions,
				signal,
				authorization: { manager: consent, grant },
			});
			const snapshots = acquired.manifest.acquisitions;
			const failures = snapshots.filter((snapshot) => snapshot.status === "failed");
			const text = [
				"Artifact root: " + acquired.root,
				"Manifest: " + acquired.manifestPath,
				"Candidates discovered: " + discovered.candidates.length,
				"Acquisition records: " + snapshots.length + "; failures: " + failures.length,
				"",
				...snapshots.map((snapshot) =>
					[
						"- " + snapshot.candidateId + ": " + snapshot.status,
						"  source=" + snapshot.sourceUrl,
						"  final=" + (snapshot.finalUrl ?? "unavailable"),
						"  local=" + (snapshot.localPath ?? "none"),
						"  commit=" +
							(snapshot.commit ?? "none") +
							"; requested_ref=" +
							(snapshot.requestedRef ?? "none") +
							"; tag=" +
							(snapshot.tag ?? "none") +
							"; sha256=" +
							(snapshot.sha256 ?? "none"),
						"  content=" +
							(snapshot.contentType ?? "unknown") +
							"; detected=" +
							(snapshot.detectedContentType ?? "unknown") +
							"; validation=" +
							(snapshot.contentValidation ?? "not-applicable"),
						snapshot.metadata
							? "  metadata=" + snapshot.metadata.provider + ":" + snapshot.metadata.recordId
							: snapshot.metadataError
								? "  metadata_error=" + snapshot.metadataError
								: "",
						"  license_files=" + (snapshot.licenseFiles?.join(", ") || "none detected"),
						snapshot.failureReason ? "  note=" + snapshot.failureReason : "",
					]
						.filter(Boolean)
						.join("\n"),
				),
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					path: pdfPath,
					artifactRoot: acquired.root,
					manifestPath: acquired.manifestPath,
					candidateCount: discovered.candidates.length,
					acquisitions: snapshots,
					failures: failures.map((failure) => failure.failureReason ?? "unknown failure"),
				},
			};
		},
	});

	pi.registerTool({
		name: "inspect_paper_artifacts",
		label: "Inspect paper artifacts",
		description:
			"Inventory files and Git repositories next to a paper PDF without modifying them. Reports repository remotes, exact commits, dirty state, and a bounded tree while skipping generated dependency directories. Use before mapping paper design or evaluation claims to code and reproduction configs.",
		promptSnippet: "Inventory artifacts and cloned repositories next to a paper PDF",
		promptGuidelines: [
			"Use inspect_paper_artifacts before analyzing implementation or reproduction parameters, then read the relevant repository files in full.",
			"Treat repository defaults, example commands, released configs, and the exact paper experiment configuration as different evidence classes.",
		],
		parameters: Type.Object({
			pdf_path: Type.String({ description: "Paper PDF path; its containing directory is inspected" }),
			max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Tree depth; default: 3" })),
			max_entries: Type.Optional(
				Type.Integer({ minimum: 50, maximum: 2_000, description: "Maximum reported entries; default: 500" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pdfPath = resolve(ctx.cwd, params.pdf_path.startsWith("@") ? params.pdf_path.slice(1) : params.pdf_path);
			let pdfStat: Stats;
			try {
				pdfStat = await lstat(pdfPath);
			} catch {
				throw new Error(`PDF not found: ${pdfPath}`);
			}
			if (!pdfStat.isFile()) throw new Error(`PDF path is not a file: ${pdfPath}`);

			const root = dirname(pdfPath);
			const maxDepth = params.max_depth ?? 3;
			const maxEntries = params.max_entries ?? 500;
			const inventory = await collectArtifacts(root, maxDepth, maxEntries);
			const repositories = await Promise.all(
				inventory.repositories.map((repositoryPath) => inspectRepository(pi, repositoryPath, signal)),
			);
			const repositoryText =
				repositories.length === 0
					? "No Git repositories found within the inspected depth."
					: repositories
							.map((repository) =>
								[
									`- path: ${repository.path}`,
									`  commit: ${repository.commit ?? "unavailable"}`,
									`  origin: ${repository.remote ?? "unavailable"}`,
									`  working_tree: ${repository.dirty ? "dirty" : "clean"}`,
								].join("\n"),
							)
							.join("\n");
			const output = [
				`Paper: ${basename(pdfPath)}`,
				`Artifact root: ${root}`,
				`Inspection limits: depth=${maxDepth}, entries=${maxEntries}`,
				"",
				"Git repositories:",
				repositoryText,
				"",
				"Bounded artifact tree:",
				inventory.entries.map(formatEntry).join("\n"),
			].join("\n");
			const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let text = truncation.content;
			if (inventory.entries.length >= maxEntries) {
				text += `\n\n[Inventory stopped at max_entries=${maxEntries}. Use built-in find/grep/read inside a relevant repository for targeted follow-up.]`;
			}
			if (truncation.truncated) {
				text += `\n\n[Output truncated at ${formatSize(truncation.maxBytes)} or ${truncation.maxLines} lines.]`;
			}
			const details: ArtifactDetails = {
				root,
				entryCount: inventory.entries.length,
				repositories,
				truncated: truncation.truncated || inventory.entries.length >= maxEntries,
			};
			return { content: [{ type: "text", text }], details };
		},
	});
}
