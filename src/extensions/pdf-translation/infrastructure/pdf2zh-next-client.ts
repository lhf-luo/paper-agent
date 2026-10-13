import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PaperAgentModelConfig, PdfTranslationEngine } from "../../../config/domain/config-types.ts";
import type { CommandExecutor } from "../../../shared/infrastructure/command-executor.ts";
import type { PdfTranslationEngineStatus, PdfTranslationOutputMode } from "../domain/pdf-translation-types.ts";
import { Pdf2zhProgressParser, type Pdf2zhProgress } from "./pdf2zh-progress.ts";

interface Pdf2zhNextClientOptions {
	executor: CommandExecutor;
}

export function resolvePdf2zhCommand(configured?: string, environment: NodeJS.ProcessEnv = process.env): string {
	const command = (environment.PAPER_AGENT_PDF2ZH_COMMAND ?? configured ?? "pdf2zh_next").trim();
	if (!command || command.length > 4_096 || /[\r\n\0]/.test(command)) {
		throw new Error("PDF2zh command must be a single executable name or path");
	}
	return command;
}

interface Pdf2zhTranslationInput {
	sourcePath: string;
	sourceLanguage: string;
	targetLanguage: string;
	outputMode: PdfTranslationOutputMode;
	engine: PdfTranslationEngine;
	command: string;
	model?: PaperAgentModelConfig;
	providerApiKey?: string;
	signal?: AbortSignal;
	onProgress?: (update: Pdf2zhProgress) => void;
}

export interface Pdf2zhTranslationOutput {
	body: Buffer;
	filename: string;
	engineVersion?: string;
}

async function pdfFiles(root: string): Promise<string[]> {
	const output: string[] = [];
	const pending = [root];
	while (pending.length) {
		const directory = pending.pop();
		if (!directory) continue;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) output.push(path);
		}
	}
	return output;
}

function parseVersion(text: string): string | undefined {
	return /pdf2zh-next version:\s*([^\s]+)/i.exec(text)?.[1];
}

function isOfficialDeepseekModel(model?: PaperAgentModelConfig): boolean {
	if (model?.providerId.toLowerCase() !== "deepseek") return false;
	try {
		const url = new URL(model.baseUrl);
		return (
			url.protocol === "https:" &&
			url.hostname === "api.deepseek.com" &&
			["/", "/v1", "/v1/"].includes(url.pathname) &&
			!url.search
		);
	} catch {
		return false;
	}
}

function engineLabel(engine: PdfTranslationEngine, model?: PaperAgentModelConfig): string {
	if (engine === "active-model") return `${model?.providerId}/${model?.modelId}`;
	return { siliconflowfree: "SiliconFlowFree", google: "Google", bing: "Bing", deepl: "DeepL" }[engine];
}

function validatePdf(body: Buffer, filename: string): void {
	if (body.length < 8 || body.subarray(0, 5).toString("latin1") !== "%PDF-") {
		throw new Error(`PDF2zh produced an invalid PDF: ${filename}`);
	}
	if (
		!body
			.subarray(Math.max(0, body.length - 8192))
			.toString("latin1")
			.includes("%%EOF")
	) {
		throw new Error(`PDF2zh output is incomplete: ${filename}`);
	}
}

export class Pdf2zhNextClient {
	private readonly executor: CommandExecutor;
	private version?: string;

	constructor(options: Pdf2zhNextClientOptions) {
		this.executor = options.executor;
	}

	private environment(apiKey?: string, variableName = "PDF2ZH_OPENAI_COMPATIBLE_API_KEY"): NodeJS.ProcessEnv {
		return {
			...(apiKey ? { [variableName]: apiKey } : {}),
		};
	}

	async status(
		command: string,
		engine: PdfTranslationEngine,
		model?: PaperAgentModelConfig,
		providerApiKey?: string,
	): Promise<PdfTranslationEngineStatus> {
		if (engine === "active-model" && !model) {
			return { available: false, engine: "pdf2zh-next", command, reason: "尚未配置可用于翻译的模型" };
		}
		if (engine === "active-model" && model?.api !== "openai-completions") {
			return {
				available: false,
				engine: "pdf2zh-next",
				command,
				activeModel: model ? `${model.providerId}/${model.modelId}` : undefined,
				reason: "当前模型不是 OpenAI 兼容接口",
			};
		}
		const apiKey = model
			? (model.apiKey ??
				(model.apiKeyEnvironmentVariable ? process.env[model.apiKeyEnvironmentVariable] : undefined))
			: undefined;
		if (engine === "active-model" && !apiKey) {
			return {
				available: false,
				engine: "pdf2zh-next",
				command,
				activeModel: model ? `${model.providerId}/${model.modelId}` : undefined,
				reason: "当前模型缺少 API 密钥",
			};
		}
		if (engine === "deepl" && !providerApiKey) {
			return {
				available: false,
				engine: "pdf2zh-next",
				command,
				activeModel: "DeepL",
				reason: "DeepL 缺少 API Key，请先在「PDF 选区翻译」设置中填写",
			};
		}
		try {
			const result = await this.executor.exec(command, ["--version"], {
				env: this.environment(),
				timeout: 60_000,
			});
			if (result.code !== 0 || result.killed) {
				throw new Error(result.stderr.trim() || "PDF2zh version probe failed");
			}
			this.version = parseVersion(`${result.stdout}\n${result.stderr}`) ?? this.version;
			return {
				available: true,
				engine: "pdf2zh-next",
				command,
				version: this.version,
				activeModel: engineLabel(engine, model),
			};
		} catch (error) {
			return {
				available: false,
				engine: "pdf2zh-next",
				command,
				activeModel: engineLabel(engine, model),
				reason: `PDF2zh Next 不可用：${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async translate(input: Pdf2zhTranslationInput): Promise<Pdf2zhTranslationOutput> {
		const apiKey = input.model
			? (input.model.apiKey ??
				(input.model.apiKeyEnvironmentVariable ? process.env[input.model.apiKeyEnvironmentVariable] : undefined))
			: undefined;
		if (input.engine === "active-model" && (!input.model || !apiKey)) {
			throw new Error("当前翻译模型缺少 API 密钥");
		}
		const command = input.command;
		const nativeDeepseek = input.engine === "active-model" && isOfficialDeepseekModel(input.model);
		const progress = input.onProgress ? new Pdf2zhProgressParser(input.onProgress) : undefined;
		const operationRoot = await mkdtemp(join(tmpdir(), `paper-agent-pdf2zh-${randomUUID()}-`));
		try {
			const args = [
				input.sourcePath,
				"--output",
				operationRoot,
				"--lang-in",
				input.sourceLanguage,
				"--lang-out",
				input.targetLanguage,
				"--report-interval",
				"2",
				"--no-auto-extract-glossary",
				input.outputMode === "dual" ? "--no-mono" : "--no-dual",
			];
			if (input.engine === "siliconflowfree") {
				args.push("--siliconflowfree");
			} else if (input.engine === "google" || input.engine === "bing") {
				args.push(`--${input.engine}`);
			} else if (input.engine === "deepl") {
				if (!input.providerApiKey) throw new Error("DeepL 缺少 API Key，请先在「PDF 选区翻译」设置中填写");
				args.push("--deepl");
			} else if (nativeDeepseek) {
				args.push("--deepseek", "--deepseek-model", input.model?.modelId ?? "");
			} else {
				args.push(
					"--openaicompatible",
					"--openai-compatible-model",
					input.model?.modelId ?? "",
					"--openai-compatible-base-url",
					input.model?.baseUrl ?? "",
				);
			}
			const result = await this.executor.exec(command, args, {
				cwd: operationRoot,
				env: this.environment(
					input.engine === "deepl" ? input.providerApiKey : apiKey,
					input.engine === "deepl"
						? "PDF2ZH_DEEPL_AUTH_KEY"
						: nativeDeepseek
							? "PDF2ZH_DEEPSEEK_API_KEY"
							: "PDF2ZH_OPENAI_COMPATIBLE_API_KEY",
				),
				signal: input.signal,
				timeout: 3 * 60 * 60_000,
				maxOutputBytes: 65_536,
				onStdout: (chunk) => progress?.feed(chunk),
				onStderr: (chunk) => progress?.feed(chunk),
			});
			if (result.killed) throw new Error(input.signal?.aborted ? "PDF 翻译已取消" : "PDF 翻译超时");
			if (result.code !== 0) {
				const output = `${result.stderr}\n${result.stdout}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
				const errorLine = output.split(/[\r\n]+/).findLast((line) => /(?:Error|Exception):\s*\S/i.test(line));
				const message = output.trim().slice(-4000) || `PDF2zh exited with code ${result.code}`;
				throw new Error(errorLine && !message.includes(errorLine) ? `${errorLine.trim()}\n${message}` : message);
			}
			const outputs = await pdfFiles(operationRoot);
			if (!outputs.length) throw new Error("PDF2zh 已完成，但没有生成 PDF 文件");
			const preferred =
				outputs.find((path) => basename(path).toLowerCase().includes(input.outputMode)) ?? outputs[0];
			const body = await readFile(preferred);
			validatePdf(body, basename(preferred));
			return { body, filename: basename(preferred), engineVersion: this.version };
		} finally {
			await rm(operationRoot, { recursive: true, force: true }).catch(() => {});
		}
	}
}
