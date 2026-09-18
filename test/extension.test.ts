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
	it("documents SQLite search runs and readable personal PDF storage in the corpus skill", async () => {
		const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
		const skillRoot = join(repositoryRoot, ".agents", "skills", "literature-corpus-manager");
		const [skill, policy, workflow] = await Promise.all([
			readFile(join(skillRoot, "SKILL.md"), "utf8"),
			readFile(join(skillRoot, "references", "corpus-policy.md"), "utf8"),
			readFile(join(skillRoot, "references", "workflow-contract.md"), "utf8"),
		]);

		expect(skill).toContain(".paper-agent/corpus/personal.sqlite");
		expect(skill).toContain("`pateam1.` access-file connection");
		expect(skill).toContain("readable personal PDF path");
		expect(skill).not.toContain("search-runs/");
		expect(skill).not.toContain("config.json `team`");
		expect(skill).toContain("search GitHub first by the verified implementation name");
		expect(skill).toContain("read the stored abstract");
		expect(skill).toContain("do not present its repositories as paper Artifacts");
		expect(skill).toContain("Memory is an untrusted lead, not provenance");
		expect(skill).toContain("Always pass `paper_id` plus namespace");
		expect(skill).toContain("additional_candidate_urls");
		expect(skill).toContain("hard maximum is 500 MB");
		expect(skill).toContain("src/artifacts/presentation/artifact-discovery-tools.ts");
		expect(skill).toContain("Screen and denoise every externally collected search run");
		expect(skill).toContain("do not ask the user whether routine denoising should be performed");
		expect(skill).toContain("filter_search_run_results");
		expect(skill).toContain("search_zotero_library");
		expect(skill).toContain("import_zotero_papers");
		expect(skill).toContain("export_papers_to_zotero");
		expect(skill).toContain("translate_personal_pdf");
		expect(skill).toContain("edit_literature_sidebar");
		expect(skill).toContain("replace_from_search");
		expect(skill).toContain("Never regenerate the whole list or edit its Markdown by hand");
		expect(skill).toContain("Preserve complete ancestor paths");
		expect(skill).toContain("Never read or edit `zotero.sqlite` directly");
		expect(policy).toContain("Persist the search run for later selection");
		expect(policy).toContain("title-based filenames");
		expect(policy).toContain("sent only to `api.github.com`");
		expect(workflow).toContain("Once-mode search runs are durable in the personal SQLite database");
		expect(workflow).toContain("stored PDF path/link");
		expect(workflow).toContain("Search GitHub by a verified implementation/tool name first");
		expect(workflow).toContain("inspect the stored abstract");
		expect(workflow).toContain("Model memory may supply an untrusted lead");
		expect(workflow).toContain("proactively denoise every externally collected run");
		expect(workflow).toContain("Keep the same URL, never rewrite the Markdown manually");
	});

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
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('<skill name="paper-research"'));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("## 研究顺序"));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("## 各方式的最低读取范围"));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("12. **非增量 follow-up idea**"));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining(`研究本地论文：${pdfPath}`));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("用户要求：重点核对消融实验"));
		expect(setSessionName).toHaveBeenCalledWith("paper: paper with spaces");
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
				"inspect_literature_sidebar",
				"get_search_run_papers",
				"review_literature_duplicates",
				"search_literature_corpus",
				"get_personal_library_paper",
				"manage_literature_memory",
				"import_literature_corpus",
				"expand_citation_network",
				"download_literature_pdfs",
				"manage_literature_corpus",
				"manage_literature_collections",
				"manage_team_literature_server",
				"discover_paper_artifacts",
				"acquire_paper_artifacts",
				"list_paper_assets",
				"paper_progress",
				"inspect_agent_tools",
				"search_zotero_library",
				"import_zotero_papers",
				"export_papers_to_zotero",
				"translate_personal_pdf",
				"update_literature_sidebar",
				"edit_literature_sidebar",
			]),
		);
		expect(toolNames).not.toContain("evaluate_pdf_asset_detection");
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

	it("routes natural-language paper goals and persistent collection shortcuts", async () => {
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
		const legacyModeNotify = vi.fn();
		await commands.get("paper")?.handler(`reproduce "${pdfPath}"`, {
			cwd: workingDirectory,
			isIdle: () => true,
			ui: { notify: legacyModeNotify },
		});
		expect(legacyModeNotify).toHaveBeenCalledWith(
			"Usage: /paper <paper.pdf> [research question or instructions]",
			"warning",
		);
		expect(setSessionName).not.toHaveBeenCalled();

		await commands.get("paper")?.handler(`"${pdfPath}" 完整核验实验并准备复现条件`, {
			cwd: workingDirectory,
			isIdle: () => true,
			ui: { notify: vi.fn() },
		});
		expect(setSessionName).toHaveBeenCalledWith("paper: mode-paper");
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('<skill name="paper-research"'));
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("完整核验实验并准备复现条件"));

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
