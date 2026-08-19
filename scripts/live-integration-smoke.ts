import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireArtifacts, artifactAcquisitionPlan } from "../src/artifact-acquisition.ts";
import { collectLiterature } from "../src/tools/collection-tools.ts";
import type { ArtifactManifest, LiteratureProvider } from "../src/literature-types.ts";
import { OperationConsentManager } from "../src/operation-consent.ts";

function execAdapter(
	command: string,
	args: string[],
	options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		let killed = false;
		const terminate = () => {
			killed = true;
			child.kill();
		};
		const timer = options.timeout ? setTimeout(terminate, options.timeout) : undefined;
		options.signal?.addEventListener("abort", terminate, { once: true });
		child.on("error", reject);
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", terminate);
			resolve({
				code: code ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				killed,
			});
		});
	});
}

const root = await mkdtemp(join(tmpdir(), "paper-agent-live-"));
try {
	const providers: LiteratureProvider[] = ["arxiv", "openalex", "crossref"];
	if (process.env.PAPER_AGENT_LIVE_SEMANTIC_SCHOLAR === "1") providers.push("semanticscholar");
	const collection = await collectLiterature({
		queries: [process.env.PAPER_AGENT_LIVE_QUERY ?? "stateful fuzzing"],
		providers,
		filters: { yearFrom: 2018 },
		pagesPerProvider: 1,
		maxResultsPerProvider: 3,
		scope: "personal",
		mode: "once",
		namespace: "live-smoke",
		cwd: root,
		reuseCorpus: false,
	});
	const successfulProviders = providers.filter(
		(provider) =>
			(collection.run.sourceCounts[provider] ?? 0) > 0 &&
			!collection.run.failures.some((item) => item.provider === provider),
	);
	if (successfulProviders.length < Math.min(2, providers.length) || collection.run.results.length === 0) {
		throw new Error(
			`live provider smoke was insufficient: successful=${successfulProviders.join(",")}; failures=${JSON.stringify(collection.run.failures)}`,
		);
	}

	const pdfPath = join(root, "live-smoke.pdf");
	await writeFile(pdfPath, "%PDF-1.4\n% live acquisition identity only\n");
	const repositoryUrl = process.env.PAPER_AGENT_LIVE_REPOSITORY ?? "https://github.com/octocat/Hello-World";
	const manifest: ArtifactManifest = {
		schemaVersion: 1,
		pdfPath,
		pdfSha256: "1".repeat(64),
		discoveredAt: new Date().toISOString(),
		candidates: [
			{
				id: "artifact-live-repository",
				url: repositoryUrl,
				kind: "repository",
				host: new URL(repositoryUrl).hostname,
				sources: [{ method: "pdftotext", page: 1, context: "live integration smoke" }],
				confidence: "high",
			},
		],
		acquisitions: [],
	};
	const acquisitionOptions = {
		maxArtifacts: 1,
		maxBytesPerArtifact: 1024 * 1024,
	};
	const consent = new OperationConsentManager();
	const prepared = await consent.prepare(artifactAcquisitionPlan(manifest, acquisitionOptions));
	const grant = await consent.confirm(prepared.operationId, prepared.manifestFingerprint, "live-smoke");
	const acquired = await acquireArtifacts({ exec: execAdapter } as unknown as ExtensionAPI, manifest, {
		...acquisitionOptions,
		authorization: { manager: consent, grant },
	});
	const snapshot = acquired.manifest.acquisitions.at(-1);
	if (
		!snapshot ||
		snapshot.status !== "cloned" ||
		!snapshot.commit ||
		!snapshot.remote ||
		!snapshot.resolvedAddresses?.length
	) {
		throw new Error(`live Git acquisition failed: ${JSON.stringify(snapshot)}`);
	}
	console.log(
		JSON.stringify(
			{
				providers: { requested: providers, successful: successfulProviders, failures: collection.run.failures },
				resultCount: collection.run.results.length,
				artifact: {
					status: snapshot.status,
					remote: snapshot.remote,
					commit: snapshot.commit,
					branch: snapshot.branch,
					resolvedAddresses: snapshot.resolvedAddresses,
					metadata: snapshot.metadata,
					metadataError: snapshot.metadataError,
				},
			},
			null,
			2,
		),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
