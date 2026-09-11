import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import type { PaperAgentModelConfig } from "../src/config/domain/config-types.ts";
import {
	Pdf2zhNextClient,
	resolvePdf2zhCommand,
} from "../src/extensions/pdf-translation/infrastructure/pdf2zh-next-client.ts";
import type { PaperRecord, PaperVersion } from "../src/literature/domain/literature-types.ts";
import type { CommandExecOptions, CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PDF translation", () => {
	it("uses the active model without exposing its key and saves the translation as a paper version", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-translation-"));
		temporaryPaths.push(root);
		const commandPath = join(root, "Tools With Space", "pdf2zh_next.exe");
		const calls: Array<{ command: string; args: string[]; options?: CommandExecOptions }> = [];
		let translationOutputDirectory = "";
		const translatedPdf = Buffer.from("%PDF-1.7\ntranslated fixture\n%%EOF\n", "latin1");
		const executor: CommandExecutor = {
			exec: async (command, args, options) => {
				calls.push({ command, args, options });
				if (args.includes("--version")) {
					return { stdout: "pdf2zh-next version: 2.9.0\n", stderr: "", code: 0, killed: false };
				}
				const outputIndex = args.indexOf("--output");
				const output = args[outputIndex + 1];
				translationOutputDirectory = output;
				await mkdir(output, { recursive: true });
				await writeFile(join(output, "fixture.zh-CN.dual.pdf"), translatedPdf);
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		};

		const config = defaultPaperAgentConfig();
		config.model = {
			providerId: "chat-provider",
			modelId: "chat-model",
			api: "openai-completions",
			baseUrl: "https://chat.example.test/v1",
			apiKey: "secret-chat-key",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_384,
		};
		const translationModel: PaperAgentModelConfig = {
			providerId: "test-provider",
			modelId: "translation-model",
			api: "openai-completions",
			baseUrl: "https://models.example.test/v1",
			apiKey: "secret-translation-key",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_384,
		};
		config.models = [config.model, translationModel];
		config.pdfTranslation = {
			engine: "active-model",
			modelKey: "test-provider/translation-model",
			command: commandPath,
		};
		await savePaperAgentConfig(root, config);

		const application = new PaperAgentApplication({
			projectRoot: root,
			dataRoot: join(root, ".paper-agent"),
			executor,
		});
		const store = application.personalStore();
		const paper: PaperRecord = {
			id: "translation-paper",
			title: "A Paper to Translate",
			authors: ["Researcher"],
			identifiers: {},
			links: [],
			provenance: [{ provider: "local-pdf", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await store.upsertPaper(paper);
		const sourceBody = Buffer.from("%PDF-1.7\nsource fixture\n%%EOF\n", "latin1");
		const sourceBlob = await store.putBlob(sourceBody);
		const source: PaperVersion = {
			paperId: paper.id,
			sourceUrl: "file:///fixture.pdf",
			finalUrl: "file:///fixture.pdf",
			retrievedAt: new Date().toISOString(),
			sha256: sourceBlob.sha256,
			bytes: sourceBody.length,
			blobPath: sourceBlob.path,
			contentType: "application/pdf",
			versionKind: "published",
			isPreferred: true,
		};
		await store.savePaperVersion(source);

		try {
			const prepared = await application.preparePdfTranslation({
				paperId: paper.id,
				sourceSha256: source.sha256,
				targetLanguage: "zh-CN",
				outputMode: "dual",
			});
			const grant = await application.confirmOperation(prepared.operationId, prepared.manifestFingerprint);
			const authorized = await application.pdfTranslation.authorize(prepared.operationId, grant);
			expect(JSON.stringify(authorized)).not.toContain("secret-translation-key");
			const result = await application.pdfTranslation.execute(authorized, {
				jobId: "translation-test",
				signal: new AbortController().signal,
				report: () => {},
			});

			expect(result).toMatchObject({
				paperId: paper.id,
				engine: "pdf2zh-next",
				engineVersion: "2.9.0",
				model: "test-provider/translation-model",
				version: { versionKind: "translation", versionLabel: "zh-CN-dual" },
			});
			const versions = await store.listPaperVersions(paper.id);
			const translated = versions.find((version) => version.versionKind === "translation");
			expect(translated).toMatchObject({
				relatedVersionSha256: source.sha256,
				isPreferred: false,
				translation: {
					engine: "pdf2zh-next",
					engineVersion: "2.9.0",
					model: "test-provider/translation-model",
					targetLanguage: "zh-CN",
					outputMode: "dual",
				},
			});
			expect(basename(translated?.blobPath ?? "")).toBe("A Paper to Translate [zh-CN-dual].pdf");
			const database = new DatabaseSync(join(root, ".paper-agent", "corpus", "personal.sqlite"), {
				readOnly: true,
			});
			try {
				const relationship = database
					.prepare("SELECT related_version_id FROM paper_versions WHERE version_kind = 'translation'")
					.get() as { related_version_id: string };
				expect(relationship.related_version_id).toBeTruthy();
			} finally {
				database.close();
			}

			const translationCall = calls.find((call) => call.args.includes("--openaicompatible"));
			expect(translationCall?.command).toBe(commandPath);
			expect(translationOutputDirectory).toContain(join(tmpdir(), "paper-agent-pdf2zh-"));
			await expect(access(translationOutputDirectory)).rejects.toThrow();
			expect(translationCall?.args).not.toContain("-m");
			expect(translationCall?.args).not.toContain("pdf2zh_next.main");
			expect(translationCall?.options?.env?.HOME).toBeUndefined();
			expect(translationCall?.options?.env?.USERPROFILE).toBeUndefined();
			expect(translationCall?.options?.env?.HF_HOME).toBeUndefined();
			expect(translationCall?.args).not.toContain("secret-translation-key");
			expect(translationCall?.options?.env?.PDF2ZH_OPENAI_COMPATIBLE_API_KEY).toBe("secret-translation-key");

			const server = await startLocalWebServer(application, { staticRoot: root });
			try {
				const request = {
					paperId: paper.id,
					namespace: "default",
					sourceSha256: source.sha256,
					sourceLanguage: "en",
					targetLanguage: "zh-CN",
					outputMode: "dual",
				};
				const prepareResponse = await fetch(`${server.url}/api/pdf-translations/prepare`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(request),
				});
				const webPrepared = (await prepareResponse.json()) as {
					operationId: string;
					manifestFingerprint: string;
				};
				const confirmResponse = await fetch(`${server.url}/api/operations/confirm`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(webPrepared),
				});
				const webGrant = await confirmResponse.json();
				const executeResponse = await fetch(`${server.url}/api/pdf-translations/execute`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...request, grant: webGrant }),
				});
				expect(executeResponse.status).toBe(202);
				expect(await executeResponse.json()).toMatchObject({ type: "pdf-translation" });
			} finally {
				await server.close();
			}

			config.pdfTranslation.engine = "siliconflowfree";
			await savePaperAgentConfig(root, config);
			expect(await application.pdfTranslationStatus()).toMatchObject({
				available: true,
				activeModel: "SiliconFlowFree",
			});
			const freePrepared = await application.preparePdfTranslation({
				paperId: paper.id,
				sourceSha256: source.sha256,
			});
			const freeGrant = await application.confirmOperation(
				freePrepared.operationId,
				freePrepared.manifestFingerprint,
			);
			const freeAuthorized = await application.pdfTranslation.authorize(freePrepared.operationId, freeGrant);
			await application.pdfTranslation.execute(freeAuthorized, {
				jobId: "free-translation-test",
				signal: new AbortController().signal,
				report: () => {},
			});
			const freeCall = calls.at(-1);
			expect(freeCall?.args).toContain("--siliconflowfree");
			expect(freeCall?.args).not.toContain("--openaicompatible");
			expect(freeCall?.options?.env?.PDF2ZH_OPENAI_COMPATIBLE_API_KEY).toBeUndefined();

			await expect(
				application.preparePdfTranslation({ paperId: paper.id, sourceSha256: result.version.sha256 }),
			).rejects.toThrow("不能再次翻译已经生成的译文版本");
		} finally {
			await application.close();
		}
	});

	it("keeps the application available when the optional extension is absent", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-without-pdf2zh-"));
		temporaryPaths.push(root);
		const missingCommand = join(root, "missing", "pdf2zh_next.exe");
		const config = defaultPaperAgentConfig();
		config.pdfTranslation.command = missingCommand;
		await savePaperAgentConfig(root, config);
		const application = new PaperAgentApplication({ projectRoot: root });
		try {
			await application.initialize();
			const status = await application.pdfTranslationStatus();
			expect(status).toMatchObject({
				available: false,
				command: missingCommand,
			});
			expect(status.reason).toContain("PDF2zh Next");
		} finally {
			await application.close();
		}
	});

	it("resolves an environment override before config and falls back to PATH", () => {
		expect(resolvePdf2zhCommand("configured-pdf2zh", { PAPER_AGENT_PDF2ZH_COMMAND: "environment-pdf2zh" })).toBe(
			"environment-pdf2zh",
		);
		expect(resolvePdf2zhCommand("configured-pdf2zh", {})).toBe("configured-pdf2zh");
		expect(resolvePdf2zhCommand(undefined, {})).toBe("pdf2zh_next");
	});

	it("removes its system temporary output directory after a command failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf2zh-failure-"));
		temporaryPaths.push(root);
		const sourcePath = join(root, "source.pdf");
		await writeFile(sourcePath, "%PDF-1.7\n%%EOF\n", "latin1");
		let operationRoot = "";
		const client = new Pdf2zhNextClient({
			executor: {
				exec: async (_command, _args, options) => {
					operationRoot = options?.cwd ?? "";
					return { stdout: "", stderr: "translation failed", code: 1, killed: false };
				},
			},
		});
		await expect(
			client.translate({
				sourcePath,
				sourceLanguage: "en",
				targetLanguage: "zh-CN",
				outputMode: "dual",
				engine: "siliconflowfree",
				command: "pdf2zh_next",
			}),
		).rejects.toThrow("translation failed");
		expect(operationRoot).toContain(join(tmpdir(), "paper-agent-pdf2zh-"));
		await expect(access(operationRoot)).rejects.toThrow();
	});
});
