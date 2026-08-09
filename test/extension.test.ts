import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import paperAgentExtension from "../src/index.ts";

type EventHandler = (event: any, context: any) => any;
type PaperCommand = { handler: (args: string, context: any) => Promise<void> };

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("paper-agent activation", () => {
	it("replaces the system prompt only after /paper validates a PDF", async () => {
		const handlers = new Map<string, EventHandler[]>();
		let paperCommand: PaperCommand | undefined;
		const sendUserMessage = vi.fn();
		const setSessionName = vi.fn();
		const pi = {
			on(event: string, handler: EventHandler) {
				const eventHandlers = handlers.get(event) ?? [];
				eventHandlers.push(handler);
				handlers.set(event, eventHandlers);
			},
			registerTool() {},
			registerCommand(name: string, command: PaperCommand) {
				if (name === "paper") paperCommand = command;
			},
			sendUserMessage,
			setSessionName,
		} as unknown as ExtensionAPI;

		paperAgentExtension(pi);
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		const sessionStart = handlers.get("session_start")?.[0];
		expect(beforeAgentStart).toBeDefined();
		expect(sessionStart).toBeDefined();
		expect(paperCommand).toBeDefined();
		if (!beforeAgentStart || !sessionStart || !paperCommand) return;

		expect(await beforeAgentStart({ systemPrompt: "other agent prompt" }, {})).toBeUndefined();

		const workingDirectory = await mkdtemp(join(tmpdir(), "paper-agent-extension-"));
		temporaryPaths.push(workingDirectory);
		const pdfPath = join(workingDirectory, "paper with spaces.pdf");
		await writeFile(pdfPath, "%PDF-1.4\n", { flag: "wx" });
		const notify = vi.fn();
		await paperCommand.handler(`"${pdfPath}" 重点核对消融实验`, {
			cwd: workingDirectory,
			isIdle: () => true,
			ui: { notify },
		});

		const systemPromptPath = join(dirname(fileURLToPath(import.meta.url)), "../src/SYSTEM.md");
		const expectedSystemPrompt = await readFile(systemPromptPath, "utf8");
		expect(await beforeAgentStart({ systemPrompt: "other agent prompt" }, {})).toEqual({
			systemPrompt: expectedSystemPrompt,
		});
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("快速略读论文"));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("用户补充要求：重点核对消融实验"));
		expect(setSessionName).toHaveBeenCalledWith("paper quick: paper with spaces");
		expect(notify).not.toHaveBeenCalled();

		await sessionStart({}, {});
		expect(await beforeAgentStart({ systemPrompt: "other agent prompt" }, {})).toBeUndefined();
	});

	it("registers the complete local workflow and routes simple collection and library commands", async () => {
		const commands = new Map<string, PaperCommand>();
		const toolNames: string[] = [];
		const sendUserMessage = vi.fn();
		const pi = {
			on() {},
			registerTool(tool: { name: string }) {
				toolNames.push(tool.name);
			},
			registerCommand(name: string, command: PaperCommand) {
				commands.set(name, command);
			},
			sendUserMessage,
			setSessionName: vi.fn(),
		} as unknown as ExtensionAPI;

		paperAgentExtension(pi);
		expect(toolNames).toEqual(
			expect.arrayContaining([
				"collect_literature",
				"search_literature_corpus",
				"manage_literature_memory",
				"import_literature_corpus",
				"expand_citation_network",
				"download_literature_pdfs",
				"manage_literature_corpus",
				"manage_team_literature_server",
				"discover_paper_artifacts",
				"acquire_paper_artifacts",
				"list_paper_assets",
				"evaluate_pdf_asset_detection",
				"paper_progress",
			]),
		);
		const collect = commands.get("collect");
		const library = commands.get("library");
		const team = commands.get("team");
		expect(collect).toBeDefined();
		expect(library).toBeDefined();
		expect(team).toBeDefined();
		if (!collect || !library || !team) return;
		await collect.handler("stateful protocol fuzzing", {
			cwd: process.cwd(),
			isIdle: () => true,
			ui: { notify: vi.fn() },
		});
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("stateful protocol fuzzing"));
		expect(sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("scope=personal, mode=once, namespace=default"),
		);
		await library.handler("search stateful fuzzing", {
			cwd: process.cwd(),
			isIdle: () => true,
			ui: { notify: vi.fn() },
		});
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("search_literature_corpus"));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("search stateful fuzzing"));
		await team.handler("audit the demo namespace", {
			cwd: process.cwd(),
			isIdle: () => true,
			ui: { notify: vi.fn() },
		});
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("manage_team_literature_server"));
	});

	it("supports explicit paper depth and persistent collection shortcuts", async () => {
		const commands = new Map<string, PaperCommand>();
		const sendUserMessage = vi.fn();
		const setSessionName = vi.fn();
		const pi = {
			on() {},
			registerTool() {},
			registerCommand(name: string, command: PaperCommand) {
				commands.set(name, command);
			},
			sendUserMessage,
			setSessionName,
		} as unknown as ExtensionAPI;
		paperAgentExtension(pi);

		const workingDirectory = await mkdtemp(join(tmpdir(), "paper-agent-modes-"));
		temporaryPaths.push(workingDirectory);
		const pdfPath = join(workingDirectory, "mode-paper.pdf");
		await writeFile(pdfPath, "%PDF-1.4\n", { flag: "wx" });
		await commands.get("paper")?.handler(`reproduce "${pdfPath}"`, {
			cwd: workingDirectory,
			isIdle: () => true,
			ui: { notify: vi.fn() },
		});
		expect(setSessionName).toHaveBeenCalledWith("paper reproduce: mode-paper");
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("为复现实验完整研究论文"));

		await commands.get("collect")?.handler('--save --namespace thesis --max 12 "stateful fuzzing"', {
			cwd: workingDirectory,
			isIdle: () => true,
			ui: { notify: vi.fn() },
		});
		expect(sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("scope=personal, mode=persistent, namespace=thesis"),
		);
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("near 12 papers"));

		await commands.get("collect")?.handler('"stateful fuzzing" "protocol state"', {
			cwd: workingDirectory,
			isIdle: () => true,
			ui: { notify: vi.fn() },
		});
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("stateful fuzzing protocol state"));
		expect(sendUserMessage).not.toHaveBeenCalledWith(expect.stringContaining('fuzzing" "protocol'));
	});
});
