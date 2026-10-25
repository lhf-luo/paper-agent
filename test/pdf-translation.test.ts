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
import { Pdf2zhProgressParser } from "../src/extensions/pdf-translation/infrastructure/pdf2zh-progress.ts";
import type { PaperRecord, PaperVersion } from "../src/literature/domain/literature-types.ts";
import {
	type CommandExecOptions,
	type CommandExecutor,
	NodeCommandExecutor,
} from "../src/shared/infrastructure/command-executor.ts";

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
		let holdTranslation = false;
		let releaseTranslation: (() => void) | undefined;
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
				options?.onStderr?.("translate 68/100\r");
				if (holdTranslation)
					await new Promise<void>((resolve) => {
						releaseTranslation = resolve;
					});
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
			const reportedProgress: number[] = [];
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
				report: (progress) => reportedProgress.push(progress),
			});
			expect(reportedProgress.some((progress) => progress > 0.08 && progress < 0.9)).toBe(true);

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
				holdTranslation = true;
				const executeResponse = await fetch(`${server.url}/api/pdf-translations/execute`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...request, grant: webGrant }),
				});
				expect(executeResponse.status).toBe(202);
				const queued = (await executeResponse.json()) as { id: string; type: string };
				expect(queued).toMatchObject({ type: "pdf-translation" });
				let runningProgress = 0;
				for (let attempt = 0; attempt < 50 && runningProgress <= 0.08; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					const running = (await (await fetch(`${server.url}/api/jobs/${queued.id}`)).json()) as {
						progress: number;
					};
					runningProgress = running.progress;
				}
				expect(runningProgress).toBeGreaterThan(0.08);
				releaseTranslation?.();
				holdTranslation = false;
				let finalStatus = "";
				for (let attempt = 0; attempt < 50 && finalStatus !== "succeeded"; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					const completed = (await (await fetch(`${server.url}/api/jobs/${queued.id}`)).json()) as {
						status: string;
					};
					finalStatus = completed.status;
				}
				expect(finalStatus).toBe("succeeded");
			} finally {
				releaseTranslation?.();
				holdTranslation = false;
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

			config.pdfTranslation.engine = "deepl";
			config.credentials = { ...config.credentials, deeplApiKey: "saved-deepl-secret" };
			await savePaperAgentConfig(root, config);
			expect(await application.pdfTranslationStatus()).toMatchObject({
				available: true,
				activeModel: "DeepL",
			});
			const deeplPrepared = await application.preparePdfTranslation({
				paperId: paper.id,
				sourceSha256: source.sha256,
			});
			expect(JSON.stringify(deeplPrepared)).not.toContain("saved-deepl-secret");
			const deeplGrant = await application.confirmOperation(
				deeplPrepared.operationId,
				deeplPrepared.manifestFingerprint,
			);
			const deeplAuthorized = await application.pdfTranslation.authorize(deeplPrepared.operationId, deeplGrant);
			expect(JSON.stringify(deeplAuthorized)).not.toContain("saved-deepl-secret");
			await application.pdfTranslation.execute(deeplAuthorized, {
				jobId: "deepl-translation-test",
				signal: new AbortController().signal,
				report: () => {},
			});
			const deeplCall = calls.at(-1);
			expect(deeplCall?.args).toContain("--deepl");
			expect(deeplCall?.args).not.toContain("saved-deepl-secret");
			expect(deeplCall?.options?.env?.PDF2ZH_DEEPL_AUTH_KEY).toBe("saved-deepl-secret");

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

	it("uses the native DeepSeek flag only for its official endpoint and streams translation progress", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf2zh-deepseek-"));
		temporaryPaths.push(root);
		const sourcePath = join(root, "source.pdf");
		await writeFile(sourcePath, "%PDF-1.7\n%%EOF\n", "latin1");
		const calls: Array<{ args: string[]; options?: CommandExecOptions }> = [];
		const updates: Array<{ progress: number; message: string }> = [];
		const client = new Pdf2zhNextClient({
			executor: {
				exec: async (_command, args, options) => {
					calls.push({ args, options });
					options?.onStderr?.("translate 6");
					options?.onStderr?.("8/100\rTranslate Paragraphs (1/1) 606/961\r");
					const output = args[args.indexOf("--output") + 1];
					await writeFile(join(output, "translated.dual.pdf"), "%PDF-1.7\ntranslated\n%%EOF\n", "latin1");
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
		});
		const model: PaperAgentModelConfig = {
			providerId: "deepseek",
			modelId: "deepseek-chat",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com/v1",
			apiKey: "native-secret",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 8192,
		};
		const request = {
			sourcePath,
			sourceLanguage: "en",
			targetLanguage: "zh-CN",
			outputMode: "dual" as const,
			engine: "active-model" as const,
			command: "pdf2zh_next",
		};
		await client.translate({ ...request, model, onProgress: (update) => updates.push(update) });
		expect(calls[0]?.args).toContain("--deepseek");
		expect(calls[0]?.args).toContain("--deepseek-model");
		expect(calls[0]?.args).not.toContain("native-secret");
		expect(calls[0]?.options?.env?.PDF2ZH_DEEPSEEK_API_KEY).toBe("native-secret");
		expect(calls[0]?.options?.env?.PDF2ZH_OPENAI_COMPATIBLE_API_KEY).toBeUndefined();
		expect(updates.at(-1)?.message).toBe("正在翻译段落 606/961");
		expect(updates.at(-1)?.progress).toBeGreaterThan(0.6);

		await client.translate({ ...request, model: { ...model, baseUrl: "https://proxy.example.test/v1" } });
		expect(calls[1]?.args).toContain("--openaicompatible");
		expect(calls[1]?.args).not.toContain("--deepseek");
		expect(calls[1]?.options?.env?.PDF2ZH_OPENAI_COMPATIBLE_API_KEY).toBe("native-secret");
	});

	it("uses the built-in Google and Bing engines without model credentials", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf2zh-builtins-"));
		temporaryPaths.push(root);
		const sourcePath = join(root, "source.pdf");
		await writeFile(sourcePath, "%PDF-1.7\n%%EOF\n", "latin1");
		const calls: Array<{ args: string[]; options?: CommandExecOptions }> = [];
		const client = new Pdf2zhNextClient({
			executor: {
				exec: async (_command, args, options) => {
					calls.push({ args, options });
					const output = args[args.indexOf("--output") + 1];
					await writeFile(join(output, "translated.dual.pdf"), "%PDF-1.7\ntranslated\n%%EOF\n", "latin1");
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
		});
		for (const engine of ["google", "bing"] as const) {
			await client.translate({
				sourcePath,
				sourceLanguage: "en",
				targetLanguage: "zh-CN",
				outputMode: "dual",
				engine,
				command: "pdf2zh_next",
			});
		}
		expect(calls.map((call) => call.args.find((arg) => ["--google", "--bing"].includes(arg)))).toEqual([
			"--google",
			"--bing",
		]);
		for (const call of calls) {
			expect(call.args).not.toContain("--openaicompatible");
			expect(call.options?.env?.PDF2ZH_OPENAI_COMPATIBLE_API_KEY).toBeUndefined();
		}
	});

	it("uses the saved DeepL key through the child environment and rejects missing keys", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf2zh-deepl-"));
		temporaryPaths.push(root);
		const sourcePath = join(root, "source.pdf");
		await writeFile(sourcePath, "%PDF-1.7\n%%EOF\n", "latin1");
		const calls: Array<{ args: string[]; options?: CommandExecOptions }> = [];
		const client = new Pdf2zhNextClient({
			executor: {
				exec: async (_command, args, options) => {
					calls.push({ args, options });
					if (args.includes("--version"))
						return { stdout: "pdf2zh-next version: 2.9.0", stderr: "", code: 0, killed: false };
					const output = args[args.indexOf("--output") + 1];
					await writeFile(join(output, "translated.dual.pdf"), "%PDF-1.7\ntranslated\n%%EOF\n", "latin1");
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
		});
		const request = {
			sourcePath,
			sourceLanguage: "en",
			targetLanguage: "zh-CN",
			outputMode: "dual" as const,
			engine: "deepl" as const,
			command: "pdf2zh_next",
		};
		expect(await client.status(request.command, request.engine)).toMatchObject({
			available: false,
			reason: expect.stringContaining("DeepL 缺少 API Key"),
		});
		await expect(client.translate(request)).rejects.toThrow("DeepL 缺少 API Key");
		expect(await client.status(request.command, request.engine, undefined, "deepl-secret")).toMatchObject({
			available: true,
			activeModel: "DeepL",
		});
		await client.translate({ ...request, providerApiKey: "deepl-secret" });
		const translationCall = calls.find((call) => call.args.includes("--deepl"));
		expect(translationCall?.args).not.toContain("deepl-secret");
		expect(translationCall?.options?.env?.PDF2ZH_DEEPL_AUTH_KEY).toBe("deepl-secret");
	});

	it("parses split and carriage-return progress without treating task counts as percentages", () => {
		const updates: Array<{ progress: number; message: string }> = [];
		const parser = new Pdf2zhProgressParser((update) => updates.push(update));
		parser.feed("Parse Page Layout (1/1) 34/34\rTranslate Paragraphs (1/1) ");
		expect(updates.at(-1)?.progress).toBe(0.08);
		parser.feed("606/961\rtranslate 68/100\r");
		expect(updates.at(-1)?.progress).toBeCloseTo(0.624);
		expect(updates.at(-1)?.message).toContain("606/961");
		parser.feed("translate 3/100\r");
		expect(updates.at(-1)?.progress).toBeCloseTo(0.624);
		parser.feed("\x1b[");
		parser.feed("2Ktranslate 69/100\r");
		expect(updates.at(-1)?.progress).toBeCloseTo(0.632);
	});

	it("delivers command output while a subprocess is running", async () => {
		const chunks: string[] = [];
		const result = await new NodeCommandExecutor().exec(
			process.execPath,
			["-e", "process.stderr.write('translate 68/100\\r'); process.stdout.write('done')"],
			{ onStderr: (chunk) => chunks.push(chunk), maxOutputBytes: 64 },
		);
		expect(result.code).toBe(0);
		expect(chunks.join("")).toContain("translate 68/100");
		expect(result.stdout).toBe("done");
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
					return {
						stdout: "",
						stderr: `IndexError: list index out of range\n${"progress\r".repeat(900)}`,
						code: 1,
						killed: false,
					};
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
		).rejects.toThrow("IndexError: list index out of range");
		expect(operationRoot).toContain(join(tmpdir(), "paper-agent-pdf2zh-"));
		await expect(access(operationRoot)).rejects.toThrow();
	});
});
