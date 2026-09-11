import { join } from "node:path";
import { acquireArtifacts } from "../../artifacts/application/artifact-acquisition.ts";
import { sha256File } from "../../artifacts/application/artifact-discovery.ts";
import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import type { AuthorizedMineruJob } from "../../extensions/mineru/application/mineru-job.ts";
import type { AuthorizedPdfTranslationJob } from "../../extensions/pdf-translation/application/pdf-translation-job.ts";
import { collectLiterature } from "../../literature/application/literature-collection.ts";
import { downloadLiteraturePdfs } from "../../literature/application/literature-download.ts";
import { expandLiteratureQueries } from "../../literature/application/literature-query-planning.ts";
import { persistPaperRecords } from "../../literature/application/literature-write.ts";
import type { ArtifactManifest } from "../../literature/domain/literature-types.ts";
import { assertKeywordSearchProviders } from "../../literature/infrastructure/literature-providers.ts";
import { analyzePdfForLibrary } from "../../pdf/application/pdf-analysis.ts";
import type {
	ArtifactDiscoveryInput,
	AuthorizedArtifactJob,
	AuthorizedCorpusImportJob,
	AuthorizedPdfDownloadJob,
	LiteratureSearchJobInput,
} from "./paper-agent-contracts.ts";
import { PaperAgentJobs } from "./paper-agent-jobs.ts";

export class PaperAgentRuntime extends PaperAgentJobs {
	protected registerJobHandlers(): void {
		this.jobs.register<LiteratureSearchJobInput, unknown>("literature-search", async (input, context) => {
			const config = await loadPaperAgentConfig(this.projectRoot);
			context.report(0.05, "preparing queries");
			const queries = expandLiteratureQueries(input.query, input.queryExpansions ?? config.search.queryExpansions);
			context.report(0.1, "searching providers and existing corpus");
			const result = await collectLiterature({
				queries,
				providers: assertKeywordSearchProviders(input.providers ?? config.search.providers),
				filters: input.filters ?? {},
				pagesPerProvider: input.pagesPerProvider ?? config.search.pagesPerProvider,
				maxResultsPerProvider: input.maxResultsPerProvider ?? config.search.maxResultsPerProvider,
				scope: "personal",
				mode: "once",
				namespace: input.namespace ?? this.defaultNamespace,
				cwd: this.projectRoot,
				corpusRoot: this.corpusRoot,
				reuseCorpus: input.reuseCorpus ?? config.search.reuseCorpus,
				checkpointPath: join(
					this.dataRoot,
					"runtime",
					"search-checkpoints",
					`${input.checkpointId ?? context.jobId}.json`,
				),
				signal: context.signal,
			});
			context.report(1, "search completed");
			return result;
		});
		this.jobs.register<{ pdfPath: string; refine?: boolean; ocr?: boolean }, unknown>(
			"pdf-analysis",
			async (input, context) => {
				context.report(0.05, "extracting PDF layout");
				const analyzed = await analyzePdfForLibrary(this.executor, input.pdfPath, this.projectRoot, {
					refine: input.refine,
					ocr: input.ocr,
					signal: context.signal,
				});
				const pdfSha256 = await sha256File(analyzed.pdfPath);
				const assets = await this.pdfAnnotationStore().apply(pdfSha256, analyzed.assets);
				context.report(1, "PDF analysis completed");
				return { ...analyzed, pdfSha256, assets };
			},
		);
		this.jobs.register<ArtifactDiscoveryInput, ArtifactManifest>("artifact-discovery", async (input, context) => {
			context.report(0.1, "extracting artifact links");
			const result = await this.discoverArtifactManifest(input, context.signal);
			context.report(1, "artifact discovery completed");
			return result;
		});
		this.jobs.register<AuthorizedPdfDownloadJob, unknown>("pdf-download", async (input, context) => {
			context.report(0.05, "validating the persisted confirmation permit");
			const result = await downloadLiteraturePdfs(
				this.personalStore(input.namespace),
				{ ...input.request, signal: context.signal },
				input.prepared,
				{ manager: this.consent, permit: input.executionPermit },
			);
			// 给新下载的论文打上"待生成略读卡"标记(方案A: 提示用户可一键生成)
			for (const version of result.downloaded) {
				try {
					await this.personalStore(input.namespace).annotatePaper(version.paperId, {
						author: "paper-agent",
						tags: ["needs-skim-card"],
					});
				} catch {
					// 打标是尽力而为, 不影响下载结果
				}
			}
			// 下载有失败时, 让任务正确反映为失败(而不是无脑 succeeded),
			// 这样任务中心能看到真实失败原因。
			if (result.failures.length > 0 && result.downloaded.length === 0) {
				const details = result.failures.map((failure) => `${failure.paperId}: ${failure.reason}`).join("; ");
				throw new Error(`PDF 下载全部失败: ${details}`);
			}
			if (result.failures.length > 0) {
				context.report(1, `PDF downloads completed with ${result.failures.length} failure(s)`);
			}
			context.report(1, "PDF downloads completed");
			return result;
		});
		this.jobs.register<AuthorizedPdfTranslationJob, unknown>("pdf-translation", (input, context) =>
			this.pdfTranslation.execute(input, context),
		);
		this.jobs.register<AuthorizedMineruJob, unknown>("mineru-extraction", (input, context) =>
			this.mineru.execute(input, context),
		);
		this.jobs.register<AuthorizedArtifactJob, unknown>("artifact-acquisition", async (input, context) => {
			context.report(0.05, "checking PDF and artifact manifest");
			const result = await acquireArtifacts(this.executor, input.manifest, {
				candidateIds: input.candidateIds,
				maxArtifacts: input.maxArtifacts,
				maxBytesPerArtifact: input.maxBytesPerArtifact,
				signal: context.signal,
				authorization: { manager: this.consent, permit: input.executionPermit },
			});
			const persistedManifestId = input.paperId
				? await this.personalStore(input.namespace).saveArtifactManifest(result.manifest, input.paperId)
				: undefined;
			const failures = result.attemptAcquisitions.filter((snapshot) => snapshot.status === "failed");
			if (result.attemptAcquisitions.length > 0 && failures.length === result.attemptAcquisitions.length) {
				throw new Error(
					`All selected artifact acquisitions failed. Manifest was preserved as ${persistedManifestId ?? result.manifestPath}. ${failures
						.map((failure) => failure.failureReason ?? "unknown failure")
						.join("; ")}`,
				);
			}
			context.report(1, "artifact acquisition completed");
			return { ...result, persistedManifestId };
		});
		this.jobs.register<AuthorizedCorpusImportJob, unknown>("corpus-import", async (input, context) => {
			context.report(0.1, "validating the persisted corpus-write confirmation permit");
			const outcomes = await persistPaperRecords(this.personalStore(input.namespace), input.records, {
				manager: this.consent,
				permit: input.executionPermit,
			});
			context.report(1, "literature records saved");
			return {
				outcomes,
				created: outcomes.filter((outcome) => outcome.status === "created").length,
				updated: outcomes.filter((outcome) => outcome.status === "updated").length,
				unchanged: outcomes.filter((outcome) => outcome.status === "unchanged").length,
				failed: outcomes.filter((outcome) => outcome.error).length,
				doiEnrichment: input.doiEnrichment,
			};
		});
	}
}
