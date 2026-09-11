import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import type { CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function pdfExecutor(): CommandExecutor {
	return {
		exec: async (command) => {
			if (command === "pdfinfo") {
				return {
					stdout: "Title: Browser Captured Paper\nAuthor: Alice Researcher; Bob Scientist\n",
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			if (command === "pdftotext") {
				return {
					stdout: "Browser Captured Paper\nAlice Researcher, Bob Scientist\nAbstract\nFixture",
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			return { stdout: "", stderr: `Unexpected command: ${command}`, code: 1, killed: false };
		},
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-connector-"));
	temporaryPaths.push(root);
	const config = defaultPaperAgentConfig();
	config.search.providers = [];
	await savePaperAgentConfig(root, config);
	const staticRoot = join(root, "dist", "web");
	await mkdir(staticRoot, { recursive: true });
	await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
	const application = new PaperAgentApplication({
		projectRoot: root,
		dataRoot: join(root, ".paper-agent"),
		executor: pdfExecutor(),
	});
	const server = await startLocalWebServer(application, { staticRoot });
	return { application, root, server };
}

describe("Paper Agent browser connector", () => {
	it("pings and imports a browser-downloaded PDF path", async () => {
		const { application, root, server } = await fixture();
		try {
			const ping = await fetch(`${server.url}/api/connector/ping`);
			expect(ping.status).toBe(200);
			expect(await ping.json()).toMatchObject({ ok: true, defaultNamespace: "default" });

			const localPath = join(root, "browser-download.pdf");
			await writeFile(localPath, "%PDF-1.4\nbrowser fixture\n%%EOF\n");
			const response = await fetch(`${server.url}/api/connector/capture-path`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					metadata: {
						pageUrl: "https://dl.acm.org/doi/10.1145/3585386",
						pdfUrl: "https://dl.acm.org/doi/pdf/10.1145/3585386",
						doi: "10.1145/3585386",
					},
					namespace: "acm",
					collection: "浏览器捕捉",
					localPath,
				}),
			});
			const responseText = await response.text();
			expect(response.status, responseText).toBe(200);
			const result = JSON.parse(responseText) as { record: { id: string; identifiers: { doi?: string } } };
			expect(result.record.identifiers.doi).toBe("10.1145/3585386");
			expect(await application.personalStore("acm").listPaperVersions(result.record.id)).toHaveLength(1);
			expect((await application.personalStore("acm").listCollections()).map((item) => item.name)).toContain(
				"浏览器捕捉",
			);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("accepts long signed PDF URLs with a browser-downloaded file", async () => {
		const { application, root, server } = await fixture();
		try {
			const localPath = join(root, "signed-download.pdf");
			await writeFile(localPath, "%PDF-1.4\nsigned fixture\n%%EOF\n");
			const longUrl = `https://example.com/main.pdf?token=${"a".repeat(8_000)}`;
			const response = await fetch(`${server.url}/api/connector/capture-path`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ metadata: { pageUrl: longUrl, pdfUrl: longUrl }, localPath }),
			});
			expect(response.status).toBe(200);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("rejects a browser-downloaded file without a PDF signature", async () => {
		const { application, root, server } = await fixture();
		try {
			const localPath = join(root, "not-a-pdf.pdf");
			await writeFile(localPath, "<html>login</html>");
			const response = await fetch(`${server.url}/api/connector/capture-path`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					metadata: { pageUrl: "https://example.com/login", pdfUrl: "https://example.com/main.pdf" },
					localPath,
				}),
			});
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ error: "Captured content does not have a PDF file signature" });
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("uses the browser download observer without injecting into publisher pages", async () => {
		const background = await readFile(join(process.cwd(), "browser-extension", "background.js"), "utf8");
		const popup = await readFile(join(process.cwd(), "browser-extension", "popup.js"), "utf8");
		const manifest = JSON.parse(
			await readFile(join(process.cwd(), "browser-extension", "manifest.json"), "utf8"),
		) as { background?: { service_worker?: string }; permissions: string[] };
		expect(manifest.permissions).toContain("downloads");
		expect(manifest.permissions).toContain("storage");
		expect(manifest.permissions).not.toContain("activeTab");
		expect(manifest.permissions).not.toContain("downloads.ui");
		expect(manifest.permissions).not.toContain("webRequest");
		expect(manifest.background?.service_worker).toBe("background.js");
		expect(background).toContain("chrome.downloads.onCreated");
		expect(background).toContain("chrome.downloads.onChanged");
		expect(background).toContain("chrome.downloads.removeFile");
		expect(background).toContain("chrome.storage.session");
		expect(popup).toContain("paper-agent:auto-capture-status");
		expect(popup).not.toContain("chrome.downloads");
		expect(popup).not.toContain("capture-path");
	});
});
