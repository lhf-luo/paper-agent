import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	loadPaperAgentConfig,
	redactPaperAgentConfig,
	resolvePaperAgentConfigPaths,
	savePaperAgentConfig,
	supportsAutomaticToolCallingProbe,
	validatePaperAgentConfig,
} from "../../config/application/config-service.ts";
import { probeModelToolCalling } from "../../config/application/model-service.ts";
import type { ArtifactManifest } from "../../literature/domain/literature-types.ts";
import type { PdfBox } from "../../pdf/domain/pdf-types.ts";
import { PdfAnnotationStore } from "../../pdf/infrastructure/pdf-annotation-store.ts";
import type { ConfirmationGrant, PreparedOperation } from "../../shared/application/operation-consent.ts";
import { applyExternalToolDirectories } from "../../shared/infrastructure/external-tool-environment.ts";

import type { PdfAssetCorrectionInput } from "./paper-agent-contracts.ts";
import { PaperAgentResearch } from "./paper-agent-research.ts";

export abstract class PaperAgentOperations extends PaperAgentResearch {
	protected pdfAnnotationStore(): PdfAnnotationStore {
		return new PdfAnnotationStore(join(this.dataRoot, "pdf-annotations"));
	}

	protected pdfCorrectionPlan(input: PdfAssetCorrectionInput) {
		const job = this.jobs.get(input.analysisJobId);
		if (
			!job ||
			job.type !== "pdf-analysis" ||
			job.status !== "succeeded" ||
			!job.result ||
			typeof job.result !== "object"
		) {
			throw new Error("Completed PDF analysis job was not found");
		}
		const result = job.result as {
			pdfPath: string;
			pdfSha256: string;
			pages: Array<{ page: number; width: number; height: number }>;
			assets: Array<{ id: string; page: number; candidateRegion: PdfBox }>;
		};
		const asset = result.assets.find((candidate) => candidate.id === input.assetId);
		if (!asset) throw new Error("The selected asset is not present in the analysis job");
		const page = result.pages.find((candidate) => candidate.page === asset.page);
		const box = input.correctedRegion;
		if (
			!page ||
			![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
			box.x < 0 ||
			box.y < 0 ||
			box.width <= 0 ||
			box.height <= 0 ||
			box.x + box.width > page.width + 0.5 ||
			box.y + box.height > page.height + 0.5
		) {
			throw new Error("Corrected asset region must fit within the physical PDF page");
		}
		const correction = {
			pdfSha256: result.pdfSha256,
			assetId: asset.id,
			page: asset.page,
			originalRegion: asset.candidateRegion,
			correctedRegion: { ...box },
			note: input.note,
			author: input.author?.trim() || "local-user",
		};
		return {
			correction,
			plan: {
				kind: "pdf-annotation-write" as const,
				summary: `Save a manual crop correction for ${asset.id}`,
				actor: correction.author,
				targets: [{ label: "PDF asset", value: `${result.pdfPath}#${asset.id}`, risk: "medium" as const }],
				details: {
					analysisJobId: input.analysisJobId,
					pdfSha256: result.pdfSha256,
					page: asset.page,
					originalRegion: asset.candidateRegion,
					correctedRegion: correction.correctedRegion,
					note: correction.note,
				},
			},
		};
	}

	async preparePdfAssetCorrection(input: PdfAssetCorrectionInput): Promise<PreparedOperation> {
		return this.consent.prepare(this.pdfCorrectionPlan(input).plan);
	}

	async savePdfAssetCorrection(input: PdfAssetCorrectionInput, grant: ConfirmationGrant) {
		const prepared = this.pdfCorrectionPlan(input);
		await this.consent.consume(grant, prepared.plan);
		return this.pdfAnnotationStore().save(prepared.correction);
	}

	async artifactJobDetails(jobId: string) {
		const job = this.jobs.get(jobId);
		if (
			!job ||
			job.type !== "artifact-acquisition" ||
			job.status !== "succeeded" ||
			!job.result ||
			typeof job.result !== "object"
		) {
			throw new Error("Completed artifact acquisition job was not found");
		}
		const result = job.result as { manifest?: ArtifactManifest; root?: string; manifestPath?: string };
		if (!result.manifest || !result.root) throw new Error("Artifact job result is incomplete");
		const root = resolve(result.root);
		const tree: Array<{ path: string; type: "file" | "directory"; bytes?: number }> = [];
		const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
		while (pending.length && tree.length < 1_500) {
			const current = pending.shift();
			if (!current) break;
			for (const entry of await readdir(current.path, { withFileTypes: true }).catch(() => [])) {
				if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
				const path = join(current.path, entry.name);
				const relativePath = relative(root, path).replaceAll("\\", "/");
				if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
				if (entry.isDirectory()) {
					tree.push({ path: relativePath, type: "directory" });
					if (current.depth < 6) pending.push({ path, depth: current.depth + 1 });
				} else if (entry.isFile()) {
					tree.push({ path: relativePath, type: "file", bytes: (await stat(path)).size });
				}
				if (tree.length >= 1_500) break;
			}
		}
		return { ...result, root, tree, truncated: tree.length >= 1_500 };
	}

	protected configurationWritePlan(value: unknown) {
		const config = validatePaperAgentConfig(value, this.projectRoot);
		return {
			config,
			plan: {
				kind: "configuration-write" as const,
				summary: "Update local Paper Agent configuration",
				actor: "local-user",
				targets: [
					{
						label: "Configuration file",
						value: resolvePaperAgentConfigPaths(this.projectRoot).directory,
						risk: "medium" as const,
					},
					{ label: "Personal namespace", value: config.storage.defaultNamespace, risk: "low" as const },
					...(config.model
						? [
								{
									label: "Model endpoint",
									value: `${config.model.providerId}/${config.model.modelId}`,
									risk: "medium" as const,
								},
							]
						: []),
				],
				details: { config: redactPaperAgentConfig(config) },
			},
		};
	}

	async prepareConfigurationWrite(value: unknown): Promise<PreparedOperation> {
		return this.consent.prepare(this.configurationWritePlan(value).plan);
	}

	async writeConfiguration(value: unknown, grant: ConfirmationGrant) {
		const prepared = this.configurationWritePlan(value);
		await this.consent.consume(grant, prepared.plan);
		const saved = await savePaperAgentConfig(this.projectRoot, prepared.config);
		applyExternalToolDirectories(saved.config.externalTools.commandDirectories);
		return {
			...saved,
			restartRequired:
				saved.config.storage.dataRoot !== this.dataRoot ||
				saved.config.storage.corpusRoot !== this.corpusRoot ||
				saved.config.storage.defaultNamespace !== this.defaultNamespace,
		};
	}

	protected async modelProbePlan() {
		const config = await loadPaperAgentConfig(this.projectRoot);
		if (!config.model) throw new Error("Configure a model endpoint before running the tool-calling probe");
		if (!supportsAutomaticToolCallingProbe(config.model.api)) {
			throw new Error(
				`Automatic probing is available only for openai-completions and openai-responses. Verify ${config.model.api} from a Pi agent session with a real tool-using task.`,
			);
		}
		return {
			config,
			plan: {
				kind: "external-api-probe" as const,
				summary: "Send one small tool-calling capability request",
				actor: "local-user",
				targets: [
					{ label: "Provider", value: config.model.baseUrl, risk: "medium" as const },
					{ label: "Model", value: config.model.modelId, risk: "low" as const },
					{
						label: "Probe result configuration",
						value: resolvePaperAgentConfigPaths(this.projectRoot).modelsFile,
						risk: "medium" as const,
					},
				],
				details: {
					api: config.model.api,
					modelId: config.model.modelId,
					purpose:
						"Verify structured function/tool calling; the request may consume a small amount of provider quota",
					persistProbeResult: true,
				},
			},
		};
	}

	async prepareModelProbe(): Promise<PreparedOperation> {
		return this.consent.prepare((await this.modelProbePlan()).plan);
	}

	async runModelProbe(grant: ConfirmationGrant) {
		const prepared = await this.modelProbePlan();
		await this.consent.consume(grant, prepared.plan);
		const result = await probeModelToolCalling(prepared.config.model!);
		prepared.config.model!.toolCallingProbe = result;
		if (result.supported) prepared.config.model!.toolCallingVerifiedAt = result.checkedAt;
		await savePaperAgentConfig(this.projectRoot, prepared.config);
		return result;
	}
}
