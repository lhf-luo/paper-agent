import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import paperAgentExtension from "../src/index.ts";
import {
	collectRegisteredTools,
	type RegisteredAgentTool,
} from "../src/shared/presentation/agent-tool-catalog.ts";

const usage = `
临时 Agent 工具调试器

用法：
  node scripts/tool-playground.ts list
  node scripts/tool-playground.ts describe <tool-name>
  node scripts/tool-playground.ts run <tool-name> --arg key=value [--arg key=value]
  node scripts/tool-playground.ts run <tool-name> --params '<json>'
  node scripts/tool-playground.ts run <tool-name> --params-file <json-file>

选项：
  --cwd <path>       工具使用的项目根目录，默认当前目录
  --timeout <ms>     调试器总超时，默认不限制
  --details-only     只输出工具返回的 details JSON

PowerShell 示例：
  node scripts/tool-playground.ts run get_personal_library_paper --arg "query=Binary-level Directed Fuzzing for Use-After-Free Vulnerabilities" --arg namespace=default
`;

async function confirm(title: string, message: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.error(`\n${title}\n${message}`);
		const answer = (await terminal.question("确认执行？输入 y 继续：")).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		terminal.close();
	}
}

function toolContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "rpc",
		hasUI: Boolean(process.stdin.isTTY),
		ui: {
			confirm,
			notify(message: string, type = "info") {
				console.error(`[${type}] ${message}`);
			},
		},
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "tool-playground",
		},
		modelRegistry: {},
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function printTool(tool: RegisteredAgentTool): void {
	console.log(`${tool.name}\n${tool.description}\n\n参数 Schema:\n${JSON.stringify(tool.parameters, null, 2)}`);
	if (tool.promptGuidelines?.length) {
		console.log(`\nAgent 使用要求:\n${tool.promptGuidelines.map((line) => `- ${line}`).join("\n")}`);
	}
}

function assignmentValue(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

async function readParameters(params?: string, paramsFile?: string, assignments: string[] = []): Promise<unknown> {
	const sourceCount = Number(Boolean(params)) + Number(Boolean(paramsFile)) + Number(assignments.length > 0);
	if (sourceCount > 1) throw new Error("--arg、--params 和 --params-file 只能选择一种参数输入方式");
	if (assignments.length) {
		return Object.fromEntries(
			assignments.map((assignment) => {
				const separator = assignment.indexOf("=");
				if (separator <= 0) throw new Error(`--arg 必须使用 key=value 格式：${assignment}`);
				return [assignment.slice(0, separator), assignmentValue(assignment.slice(separator + 1))];
			}),
		);
	}
	const raw = params ?? (paramsFile ? await readFile(resolve(process.cwd(), paramsFile), "utf8") : "{}");
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具参数必须是 JSON object");
	return parsed;
}

function validatedParameters(tool: RegisteredAgentTool, raw: unknown): any {
	const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
	if (Check(tool.parameters, prepared)) return prepared;
	const failures = Errors(tool.parameters, prepared)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("\n");
	throw new Error(`参数不符合 ${tool.name} 的 Schema：\n${failures}`);
}

async function runTool(
	tool: RegisteredAgentTool,
	parameters: unknown,
	cwd: string,
	timeoutMs?: number,
	detailsOnly = false,
): Promise<void> {
	const controller = new AbortController();
	const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	try {
		const result = await tool.execute(
			`playground-${Date.now()}`,
			validatedParameters(tool, parameters),
			controller.signal,
			(update) => console.error(`[update] ${JSON.stringify(update)}`),
			toolContext(cwd),
		);
		console.log(JSON.stringify(detailsOnly ? result.details : result, null, 2));
	} finally {
		if (timer) clearTimeout(timer);
		process.removeListener("SIGINT", interrupt);
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			cwd: { type: "string" },
			arg: { type: "string", multiple: true },
			params: { type: "string" },
			"params-file": { type: "string" },
			timeout: { type: "string" },
			"details-only": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help || positionals.length === 0) {
		console.log(usage.trim());
		return;
	}

	const tools = new Map(collectRegisteredTools(paperAgentExtension).map((tool) => [tool.name, tool]));
	const command = positionals[0];
	if (command === "list") {
		for (const tool of [...tools.values()].sort((left, right) => left.name.localeCompare(right.name))) {
			console.log(`${tool.name}\t${tool.label}`);
		}
		return;
	}

	const toolName = positionals[1];
	if (!toolName) throw new Error(`${command} 需要工具名称\n\n${usage.trim()}`);
	const tool = tools.get(toolName);
	if (!tool) throw new Error(`未知工具：${toolName}。先运行 list 查看工具名称。`);
	if (command === "describe") {
		printTool(tool);
		return;
	}
	if (command !== "run") throw new Error(`未知命令：${command}\n\n${usage.trim()}`);

	const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
	if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
		throw new Error("--timeout 必须是正整数毫秒数");
	}
	const parameters = await readParameters(values.params, values["params-file"], values.arg);
	await runTool(tool, parameters, resolve(values.cwd ?? process.cwd()), timeoutMs, values["details-only"]);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
