import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArtifactTools } from "./tools/artifact-tools.ts";
import { registerCollectionTools } from "./tools/collection-tools.ts";
import { registerLiteratureImportTool } from "./tools/literature-import.ts";
import { registerPaperPackageTools } from "./tools/paper-package-tools.ts";
import { registerPdfAssetEvaluationTool } from "./tools/pdf-asset-evaluation.ts";
import { registerPdfAssetTools } from "./tools/pdf-asset-tools.ts";
import { registerPdfTools } from "./tools/pdf-tools.ts";
import { registerProgressTool } from "./tools/progress-tools.ts";
import { registerResearchTools } from "./tools/research-tools.ts";
import { registerTeamCorpusClientTool } from "./tools/team-corpus-client.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
export const paperSystemPrompt = readFileSync(resolve(extensionDirectory, "SYSTEM.md"), "utf8");

interface PaperCommandArguments {
	path: string;
	instructions: string;
	mode: PaperMode;
}

type PaperMode = "quick" | "methods" | "full" | "reproduce";

function parsePaperCommandArguments(value: string): PaperCommandArguments | undefined {
	let trimmed = value.trim();
	if (!trimmed) return undefined;
	let mode: PaperMode = "quick";
	const modePrefix = /^(?:--mode(?:=|\s+))?(quick|methods|full|reproduce)\s+/i.exec(trimmed);
	if (modePrefix) {
		mode = modePrefix[1].toLowerCase() as PaperMode;
		trimmed = trimmed.slice(modePrefix[0].length).trim();
	}

	const quoted = /^(["'])(.*?)\1(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (quoted) return { path: quoted[2], instructions: quoted[3]?.trim() ?? "", mode };

	const unquoted = /^(.+?\.pdf)(?:\s+([\s\S]*))?$/i.exec(trimmed);
	return unquoted ? { path: unquoted[1].trim(), instructions: unquoted[2]?.trim() ?? "", mode } : undefined;
}

function paperKickoff(mode: PaperMode, absolutePath: string): string {
	if (mode === "quick") {
		return `快速略读论文 ${absolutePath}。先确认 PDF 身份和总页数，阅读摘要、引言、结论以及定位核心方法和实验所需的页面；给出研究问题、核心方法、主要证据、明显局限和是否值得精读。不要暗示已覆盖全文，不要自动下载 artifact；最后给出可选下一步：方法精读、完整报告或复现准备。`;
	}
	if (mode === "methods") {
		return `方法精读论文 ${absolutePath}。确认 PDF 身份和总页数，重点覆盖方法、算法、核心公式、关键图表和与方法 claim 直接相关的实验；建立必要的正文 mention、section 和图表上下文。未覆盖的页面和未核实的 artifact 必须写入证据边界，不要自动下载 artifact。`;
	}
	if (mode === "reproduce") {
		return `为复现实验完整研究论文 ${absolutePath}。覆盖全部 PDF 页、图表和附录；发现并安全获取官方 artifact，检查 manifest、commit、license 和失败；检查代码入口与最终生效参数，不执行未知代码；调用 paper_progress，并严格输出 12 节中文报告、复现参数表和一周最小实验。`;
	}
	return `完整研究论文 ${absolutePath}。读取全部 PDF 页，包括参考文献和附录；建立论文内部图表资产索引，对支撑核心 claim 的图表做布局、区域与表格核验；发现 artifact，但在实际下载或 clone 前先说明候选和操作；检索并核对一手来源；调用 paper_progress，最后严格按照论文研究报告的 12 个问题输出中文总结。`;
}

interface CollectCommandArguments {
	query: string;
	mode: "once" | "persistent";
	namespace: string;
	maxResults?: number;
}

function parseCollectCommandArguments(value: string): CollectCommandArguments | undefined {
	const tokens = value.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	if (!tokens.length) return undefined;
	let mode: "once" | "persistent" = "once";
	let namespace = "default";
	let maxResults: number | undefined;
	let index = 0;
	while (index < tokens.length && tokens[index].startsWith("--")) {
		const option = tokens[index].toLowerCase();
		if (option === "--save" || option === "--persistent") {
			mode = "persistent";
			index += 1;
			continue;
		}
		if (option === "--once") {
			mode = "once";
			index += 1;
			continue;
		}
		if (option === "--namespace" && tokens[index + 1]) {
			namespace = tokens[index + 1].replace(/^["']|["']$/g, "");
			index += 2;
			continue;
		}
		if (option === "--max" && /^\d+$/.test(tokens[index + 1] ?? "")) {
			maxResults = Number(tokens[index + 1]);
			index += 2;
			continue;
		}
		break;
	}
	const query = tokens
		.slice(index)
		.map((token) => token.replace(/^(["'])([\s\S]*)\1$/, "$2"))
		.join(" ")
		.trim();
	return query ? { query, mode, namespace, maxResults } : undefined;
}

export default function paperAgentExtension(pi: ExtensionAPI): void {
	let paperModeActive = false;

	registerPdfTools(pi);
	registerPdfAssetTools(pi);
	registerPdfAssetEvaluationTool(pi);
	registerArtifactTools(pi);
	registerCollectionTools(pi);
	registerLiteratureImportTool(pi);
	registerPaperPackageTools(pi);
	registerResearchTools(pi);
	registerTeamCorpusClientTool(pi);
	registerProgressTool(pi);

	pi.on("session_start", () => {
		paperModeActive = false;
	});

	pi.on("before_agent_start", () => (paperModeActive ? { systemPrompt: paperSystemPrompt } : undefined));

	pi.registerCommand("paper", {
		description: "Read a PDF and its adjacent artifacts as a research paper",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /paper when the current turn finishes.", "warning");
				return;
			}
			const commandArguments = parsePaperCommandArguments(args);
			if (!commandArguments) {
				ctx.ui.notify("Usage: /paper [quick|methods|full|reproduce] <paper.pdf> [instructions]", "warning");
				return;
			}
			const inputPath = commandArguments.path;
			const absolutePath = resolve(ctx.cwd, inputPath.startsWith("@") ? inputPath.slice(1) : inputPath);
			if (extname(absolutePath).toLowerCase() !== ".pdf") {
				ctx.ui.notify(`Expected a .pdf file: ${absolutePath}`, "error");
				return;
			}
			try {
				const fileStat = await stat(absolutePath);
				if (!fileStat.isFile()) throw new Error("not a file");
			} catch {
				ctx.ui.notify(`PDF not found: ${absolutePath}`, "error");
				return;
			}

			paperModeActive = true;
			pi.setSessionName(`paper ${commandArguments.mode}: ${basename(absolutePath, extname(absolutePath))}`);
			const kickoff = paperKickoff(commandArguments.mode, absolutePath);
			pi.sendUserMessage(
				commandArguments.instructions ? `${kickoff}\n\n用户补充要求：${commandArguments.instructions}` : kickoff,
			);
		},
	});

	pi.registerCommand("collect", {
		description: "Collect literature; add --save only when you want a persistent personal library",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /collect when the current turn finishes.", "warning");
				return;
			}
			const commandArguments = parseCollectCommandArguments(args);
			if (!commandArguments) {
				ctx.ui.notify("Usage: /collect [--save] [--namespace name] [--max N] <research query>", "warning");
				return;
			}
			pi.setSessionName("collect: " + commandArguments.query.slice(0, 60));
			pi.sendUserMessage(
				[
					"Build a literature collection for this focused query: " + commandArguments.query,
					"First propose explicit query variants and inclusion filters, then use collect_literature.",
					`Use scope=personal, mode=${commandArguments.mode}, namespace=${commandArguments.namespace}.`,
					commandArguments.maxResults
						? `Keep the final candidate set near ${commandArguments.maxResults} papers; use controlled provider limits.`
						: "Use conservative provider limits and avoid an unnecessarily broad search.",
					"Search the existing corpus first. Never write directly to team scope; team reuse requires an explicit proposal and review.",
					"Report provider failures and provenance. Search metadata is discovery evidence, not proof.",
					commandArguments.mode === "once"
						? "After reporting results, offer to save them to the personal library, download selected PDFs, or create a screening table. Do not persist without confirmation."
						: "Persist the collection to the selected personal namespace and report the resulting corpus path and audit counts.",
				].join("\n"),
			);
		},
	});

	pi.registerCommand("library", {
		description: "Search, inspect, export, or curate your personal and team literature libraries",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /library when the current turn finishes.", "warning");
				return;
			}
			const request = args.trim() || "show a concise overview of my default personal library";
			pi.setSessionName("library: " + request.slice(0, 60));
			pi.sendUserMessage(
				[
					"Handle this literature-library request: " + request,
					"Use search_literature_corpus and manage_literature_corpus for personal data; use manage_team_literature_server only when a team service is configured.",
					"Default to scope=personal and namespace=default unless the request names another namespace.",
					"For a bare overview, audit the personal corpus and report namespaces, record counts, recent activity, and useful next actions.",
					"Never expose credentials or copy personal notes and screening opinions into the team corpus.",
				].join("\n"),
			);
		},
	});

	pi.registerCommand("team", {
		description: "Search, propose, review, audit, or back up the configured team library",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /team when the current turn finishes.", "warning");
				return;
			}
			const request = args.trim() || "show team-library status and a concise audit";
			pi.setSessionName("team: " + request.slice(0, 60));
			pi.sendUserMessage(
				[
					"Handle this shared team-library request: " + request,
					"Use manage_team_literature_server. If the service is not configured, explain how to run paper-agent --team demo (or paper-agent --team demo --agent) for a local exercise, or configure a production server.",
					"For proposals, select records from the personal corpus and preserve the explicit review gate. Never include personal notes or screening opinions.",
					"Do not reveal bearer tokens, API keys, or Authorization headers.",
				].join("\n"),
			);
		},
	});
}
