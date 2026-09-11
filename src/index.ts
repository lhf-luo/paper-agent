import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProgressTool } from "./app/presentation/progress-tools.ts";
import { registerArtifactTools } from "./artifacts/presentation/artifact-tools.ts";
import { registerPaperPackageTools } from "./artifacts/presentation/paper-package-tools.ts";
import { loadPaperAgentConfigSync } from "./config/application/config-service.ts";
import { registerMineruTools } from "./extensions/mineru/presentation/mineru-tools.ts";
import { registerPdfTranslationTool } from "./extensions/pdf-translation/presentation/pdf-translation-tools.ts";
import { registerZoteroTools } from "./extensions/zotero/presentation/zotero-tools.ts";
import { setProviderCredentials } from "./literature/infrastructure/literature-providers.ts";
import { registerCollectionTools } from "./literature/presentation/collection-tools.ts";
import { registerBibtexTool } from "./literature/presentation/literature-bibtex.ts";
import { registerLiteratureDiscoveryTools } from "./literature/presentation/literature-discovery-tools.ts";
import { registerLiteratureImportTool } from "./literature/presentation/literature-import-tools.ts";
import { registerPdfAssetTools } from "./pdf/presentation/pdf-asset-tools.ts";
import { registerPdfTools } from "./pdf/presentation/pdf-tools.ts";
import { registerResearchTools } from "./research/presentation/research-tools.ts";
import { applyExternalToolDirectories } from "./shared/infrastructure/external-tool-environment.ts";
import { setProxyBypassHosts, setProxyUrl } from "./shared/infrastructure/network-proxy-config.ts";
import { captureAgentToolCatalog, registerAgentToolCatalogTool } from "./shared/presentation/agent-tool-catalog.ts";
import { setTeamProjectRoot } from "./team/application/team-corpus-client.ts";
import { registerTeamCorpusClientTool } from "./team/presentation/team-corpus-tools.ts";
import { registerWikiTools } from "./wiki/presentation/wiki-tools.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
export const paperSystemPrompt = readFileSync(resolve(extensionDirectory, "SYSTEM.md"), "utf8");
const paperResearchSkillPath = resolve(extensionDirectory, "..", ".agents", "skills", "paper-research", "SKILL.md");
const paperResearchSkillBody = readFileSync(paperResearchSkillPath, "utf8")
	.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
	.trim();
export const paperResearchSkillPrompt = [
	`<skill name="paper-research" location="${paperResearchSkillPath}">`,
	`References are relative to ${dirname(paperResearchSkillPath)}.`,
	"",
	paperResearchSkillBody,
	"</skill>",
].join("\n");

/** 启动时同步拆分配置里的代理、凭据和团队连接。 */
function applySyncConfig(): void {
	setTeamProjectRoot(resolve(extensionDirectory, ".."));
	try {
		const config = loadPaperAgentConfigSync(resolve(extensionDirectory, ".."));
		applyExternalToolDirectories(config.externalTools.commandDirectories);
		if (config.network?.proxyEnabled && config.network.proxyUrl) setProxyUrl(config.network.proxyUrl);
		if (config.network?.noProxyHosts?.length) setProxyBypassHosts(config.network.noProxyHosts);
		if (config.credentials) setProviderCredentials(config.credentials);
	} catch {
		// 无配置文件或损坏时保持默认行为。
	}
}

interface PaperCommandArguments {
	path: string;
	instructions: string;
}

function parsePaperCommandArguments(value: string): PaperCommandArguments | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const quoted = /^(["'])(.*?)\1(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (quoted) return { path: quoted[2], instructions: quoted[3]?.trim() ?? "" };

	const unquoted = /^(.+?\.pdf)(?:\s+([\s\S]*))?$/i.exec(trimmed);
	return unquoted ? { path: unquoted[1].trim(), instructions: unquoted[2]?.trim() ?? "" } : undefined;
}

function paperKickoff(absolutePath: string, instructions: string): string {
	return [
		paperResearchSkillPrompt,
		"",
		`研究本地论文：${absolutePath}`,
		instructions ? `用户要求：${instructions}` : "用户未指定研究重点，请先进行有边界的略读并给出可继续深入的问题。",
	].join("\n");
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
	applySyncConfig();
	const toolCatalog = captureAgentToolCatalog(pi);
	let paperResearchActive = false;

	registerPdfTools(pi);
	registerPdfAssetTools(pi);
	registerArtifactTools(pi);
	registerBibtexTool(pi);
	registerCollectionTools(pi);
	registerLiteratureImportTool(pi);
	registerLiteratureDiscoveryTools(pi);
	registerPaperPackageTools(pi);
	registerResearchTools(pi);
	registerWikiTools(pi);
	registerTeamCorpusClientTool(pi);
	registerZoteroTools(pi);
	registerPdfTranslationTool(pi);
	registerMineruTools(pi);
	registerProgressTool(pi);
	registerAgentToolCatalogTool(pi, toolCatalog);

	pi.on("session_start", () => {
		paperResearchActive = false;
	});

	pi.on("before_agent_start", () => (paperResearchActive ? { systemPrompt: paperSystemPrompt } : undefined));

	pi.registerCommand("paper", {
		description: "Read a PDF and its adjacent artifacts as a research paper",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy. Run /paper when the current turn finishes.", "warning");
				return;
			}
			const commandArguments = parsePaperCommandArguments(args);
			if (!commandArguments) {
				ctx.ui.notify("Usage: /paper <paper.pdf> [research question or instructions]", "warning");
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

			paperResearchActive = true;
			pi.setSessionName(`paper: ${basename(absolutePath, extname(absolutePath))}`);
			pi.sendUserMessage(paperKickoff(absolutePath, commandArguments.instructions));
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
			pi.setSessionName(`collect: ${commandArguments.query.slice(0, 60)}`);
			pi.sendUserMessage(
				[
					`Build a literature collection for this focused query: ${commandArguments.query}`,
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
			pi.setSessionName(`library: ${request.slice(0, 60)}`);
			pi.sendUserMessage(
				[
					`Handle this literature-library request: ${request}`,
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
			pi.setSessionName(`team: ${request.slice(0, 60)}`);
			pi.sendUserMessage(
				[
					`Handle this shared team-library request: ${request}`,
					"Use manage_team_literature_server. If the service is not configured, explain how to run paper-agent --team demo (or paper-agent --team demo --agent) for a local exercise, or configure a production server.",
					"For proposals, select records from the personal corpus and preserve the explicit review gate. Never include personal notes or screening opinions.",
					"Do not reveal bearer tokens, API keys, or Authorization headers.",
				].join("\n"),
			);
		},
	});
}
