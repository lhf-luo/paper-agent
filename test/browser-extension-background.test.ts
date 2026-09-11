import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Listener = (...args: any[]) => void;

interface DownloadItem {
	byExtensionId?: string;
	filename: string;
	finalUrl?: string;
	id: number;
	mime?: string;
	referrer?: string;
	state: "complete" | "in_progress" | "interrupted";
	url: string;
}

interface BackgroundApi {
	captureStatus(): Promise<Record<string, unknown> | undefined>;
	handleDownload(item: DownloadItem): Promise<void>;
	recoverBackgroundState(): Promise<void>;
}

interface HarnessOptions {
	captureStatus?: number;
	captureResponse?: Promise<Response>;
	download?: Partial<DownloadItem>;
	initialSession?: Record<string, unknown>;
	pingStatus?: number;
	removeFileError?: string;
}

const baseDownload: DownloadItem = {
	filename: "C:/Downloads/paper.pdf",
	finalUrl: "https://dl.acm.org/doi/pdf/10.1145/3548606.3560625",
	id: 41,
	mime: "application/pdf",
	referrer: "https://dl.acm.org/doi/10.1145/3548606.3560625",
	state: "complete",
	url: "https://dl.acm.org/doi/pdf/10.1145/3548606.3560625",
};

async function backgroundHarness(options: HarnessOptions = {}) {
	const session = new Map(Object.entries(options.initialSession ?? {}));
	const createdListeners: Listener[] = [];
	const changedListeners: Listener[] = [];
	const item = { ...baseDownload, ...options.download };
	const removedDownloadIds: number[] = [];
	const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
	const event = (listeners: Listener[] = []) => ({ addListener: (listener: Listener) => listeners.push(listener) });
	const chrome = {
		downloads: {
			onChanged: event(changedListeners),
			onCreated: event(createdListeners),
			removeFile: async (downloadId: number) => {
				if (options.removeFileError) throw new Error(options.removeFileError);
				removedDownloadIds.push(downloadId);
			},
			search: async () => [item],
		},
		runtime: { id: "paper-agent-extension", onMessage: event() },
		storage: {
			session: {
				get: async (key: string | null) => {
					if (key === null) return Object.fromEntries(session);
					return session.has(key) ? { [key]: session.get(key) } : {};
				},
				remove: async (key: string) => session.delete(key),
				set: async (values: Record<string, unknown>) => {
					for (const [key, value] of Object.entries(values)) session.set(key, value);
				},
			},
		},
	};
	const context = createContext({
		URL,
		chrome,
		console,
		crypto: webcrypto,
		fetch: async (url: string, init?: RequestInit) => {
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
			requests.push({ url, body });
			if (url.endsWith("/api/connector/ping")) {
				return new Response(JSON.stringify({ defaultNamespace: "default", ok: true }), {
					headers: { "content-type": "application/json" },
					status: options.pingStatus ?? 200,
				});
			}
			if (options.captureResponse) return options.captureResponse;
			return new Response(
				JSON.stringify({ error: "Import rejected", record: { id: "paper-1", title: "Captured Paper" } }),
				{
					headers: { "content-type": "application/json" },
					status: options.captureStatus ?? 200,
				},
			);
		},
		Response,
	});
	runInContext(await readFile(join(process.cwd(), "browser-extension", "background.js"), "utf8"), context);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const api = (context as unknown as { PaperAgentConnectorBackground: BackgroundApi }).PaperAgentConnectorBackground;
	return { api, changedListeners, createdListeners, item, removedDownloadIds, requests, session };
}

describe("browser extension automatic PDF capture", () => {
	it("imports a completed user PDF download and removes the original download", async () => {
		const harness = await backgroundHarness();
		harness.createdListeners[0](harness.item);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await harness.api.captureStatus()).toMatchObject({
			state: "succeeded",
			recordId: "paper-1",
			title: "Captured Paper",
			originalDeleted: true,
		});
		expect(harness.removedDownloadIds).toEqual([41]);
		expect(harness.requests).toHaveLength(2);
		expect(harness.requests[1]).toMatchObject({
			body: {
				localPath: "C:/Downloads/paper.pdf",
				namespace: "default",
				metadata: {
					pageUrl: "https://dl.acm.org/doi/10.1145/3548606.3560625",
					pdfUrl: "https://dl.acm.org/doi/pdf/10.1145/3548606.3560625",
				},
			},
		});
	});

	it("ignores non-PDF downloads", async () => {
		const harness = await backgroundHarness({
			download: {
				filename: "C:/Downloads/article.html",
				finalUrl: undefined,
				mime: "text/html",
				url: "https://example.com/article",
			},
		});
		await harness.api.handleDownload(harness.item);
		expect(await harness.api.captureStatus()).toBeUndefined();
		expect(harness.requests).toEqual([]);
	});

	it("waits for an in-progress PDF download to complete before importing it", async () => {
		const harness = await backgroundHarness({ download: { state: "in_progress" } });
		harness.createdListeners[0](harness.item);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect([...harness.session.keys()]).toContain("auto-download:41");
		harness.item.state = "complete";
		harness.changedListeners[0]({ id: 41, state: { current: "complete" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await harness.api.captureStatus()).toMatchObject({ state: "succeeded", recordId: "paper-1" });
	});

	it("reports that a completed PDF is being imported before the local request finishes", async () => {
		let resolveCapture: ((response: Response) => void) | undefined;
		const captureResponse = new Promise<Response>((resolve) => {
			resolveCapture = resolve;
		});
		const harness = await backgroundHarness({ captureResponse });
		const pending = harness.api.handleDownload(harness.item);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await harness.api.captureStatus()).toMatchObject({
			state: "importing",
			title: "paper",
		});
		resolveCapture?.(
			new Response(JSON.stringify({ record: { id: "paper-1", title: "Captured Paper" } }), { status: 200 }),
		);
		await pending;
		expect(await harness.api.captureStatus()).toMatchObject({ state: "succeeded", recordId: "paper-1" });
	});

	it("does not queue a download while Paper Agent is unavailable", async () => {
		const harness = await backgroundHarness({ pingStatus: 503 });
		await harness.api.handleDownload(harness.item);
		expect(await harness.api.captureStatus()).toMatchObject({
			state: "ignored",
			error: "Paper Agent 未运行，已忽略这次 PDF 下载",
		});
		expect([...harness.session.keys()]).not.toContain("auto-download:41");
	});

	it("records an import failure without deleting the user's download", async () => {
		const harness = await backgroundHarness({ captureStatus: 422 });
		await harness.api.handleDownload(harness.item);
		expect(await harness.api.captureStatus()).toMatchObject({ state: "failed", error: "Import rejected" });
		expect(harness.requests).toHaveLength(2);
		expect(harness.removedDownloadIds).toEqual([]);
	});

	it("reports a cleanup warning when an imported original download cannot be removed", async () => {
		const harness = await backgroundHarness({ removeFileError: "file is locked" });
		await harness.api.handleDownload(harness.item);
		expect(await harness.api.captureStatus()).toMatchObject({
			state: "succeeded",
			originalDeleted: false,
			cleanupWarning: "论文已导入，但原下载文件删除失败：file is locked",
		});
	});

	it("recovers a completed PDF that was tracked before a service-worker restart", async () => {
		const harness = await backgroundHarness({ initialSession: { "auto-download:41": { downloadId: 41 } } });
		await harness.api.recoverBackgroundState();
		expect(await harness.api.captureStatus()).toMatchObject({ state: "succeeded", recordId: "paper-1" });
	});
});
