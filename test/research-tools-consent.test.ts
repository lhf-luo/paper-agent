import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicUrl } from "../src/network-security.ts";
import { registerResearchTools } from "../src/tools/research-tools.ts";

vi.mock("../src/network-security.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/network-security.ts")>()),
	fetchPublicUrl: vi.fn(),
}));

const temporaryPaths: string[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function registeredFetchTool(): any {
	let fetchTool: any;
	registerResearchTools({
		registerTool(tool: { name: string }) {
			if (tool.name === "fetch_url") fetchTool = tool;
		},
	} as unknown as ExtensionAPI);
	return fetchTool;
}

function pdfResponse() {
	return {
		response: new Response(Buffer.from("%PDF-1.4\nconfirmed fixture\n"), {
			status: 200,
			headers: { "content-type": "application/pdf" },
		}),
		finalUrl: new URL("https://example.org/paper.pdf"),
	};
}

async function temporaryDownloadDirectories(): Promise<Set<string>> {
	return new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-paper-download-")));
}

describe("fetch_url PDF consent", () => {
	beforeEach(() => {
		vi.mocked(fetchPublicUrl).mockImplementation(async () => pdfResponse());
	});

	it("does not create a temporary PDF when no interactive confirmation UI is available", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-fetch-consent-"));
		temporaryPaths.push(root);
		const before = await temporaryDownloadDirectories();
		const tool = registeredFetchTool();

		await expect(
			tool.execute(
				"fetch-blocked",
				{ url: "https://example.org/paper.pdf" },
				new AbortController().signal,
				undefined,
				{ cwd: root, hasUI: false, ui: { confirm: vi.fn() } },
			),
		).rejects.toThrow("storing them requires interactive confirmation");

		const after = await temporaryDownloadDirectories();
		expect([...after].filter((name) => !before.has(name))).toEqual([]);
	});

	it("writes the fetched PDF only after the exact manifest is confirmed", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-fetch-confirmed-"));
		temporaryPaths.push(root);
		const confirm = vi.fn(async () => true);
		const tool = registeredFetchTool();
		const result = await tool.execute(
			"fetch-confirmed",
			{ url: "https://example.org/paper.pdf" },
			new AbortController().signal,
			undefined,
			{ cwd: root, hasUI: true, ui: { confirm } },
		);
		const downloadedPdfPath = result.details.downloadedPdfPath as string;
		temporaryPaths.push(dirname(downloadedPdfPath));

		expect(confirm).toHaveBeenCalledWith("Store fetched PDF temporarily?", expect.stringContaining("Manifest:"));
		expect(await readFile(downloadedPdfPath, "utf8")).toContain("confirmed fixture");
		expect(await readFile(join(root, ".paper-agent", "audit", "operations.jsonl"), "utf8")).toContain(
			'"event":"consumed"',
		);
	});
});
