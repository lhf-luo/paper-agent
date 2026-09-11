const CONNECTOR_URL = "http://127.0.0.1:43127";
const DOWNLOAD_PREFIX = "auto-download:";
const LATEST_KEY = "auto-capture:latest";
const processing = new Set();

const downloadKey = (downloadId) => `${DOWNLOAD_PREFIX}${downloadId}`;

async function storedValue(key) {
	return (await chrome.storage.session.get(key))[key];
}

async function saveValue(key, value) {
	await chrome.storage.session.set({ [key]: value });
}

async function removeValue(key) {
	await chrome.storage.session.remove(key);
}

async function responseJson(response) {
	const value = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
	return value;
}

function readableError(error) {
	return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function httpsUrl(value) {
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}

function sourceUrl(item) {
	return httpsUrl(item.finalUrl) || httpsUrl(item.url) || httpsUrl(item.referrer);
}

function looksLikePdf(item) {
	if (item.mime?.split(";", 1)[0].trim().toLowerCase() === "application/pdf") return true;
	if (/\.pdf$/i.test(item.filename || "")) return true;
	const url = sourceUrl(item);
	if (!url) return false;
	const pathname = new URL(url).pathname;
	return /\.pdf$/i.test(pathname) || /\/doi\/pdf(?:\/|$)/i.test(pathname) || /\/pdf(?:\/|$)/i.test(pathname);
}

function titleFromFilename(filename) {
	const name = (filename || "").split(/[\\/]/).pop() || "PDF";
	return name.replace(/\.pdf$/i, "").trim() || "PDF";
}

function captureMetadata(item) {
	const pdfUrl = sourceUrl(item);
	const pageUrl = httpsUrl(item.referrer) || pdfUrl;
	return { pageUrl, pdfUrl, title: titleFromFilename(item.filename), authors: [] };
}

async function saveLatest(item, state, details = {}) {
	const value = {
		downloadId: item.id,
		filename: item.filename,
		state,
		updatedAt: Date.now(),
		...details,
	};
	await saveValue(LATEST_KEY, value);
	return value;
}

async function connectorStatus() {
	return responseJson(await fetch(`${CONNECTOR_URL}/api/connector/ping`));
}

async function removeOriginalDownload(item) {
	try {
		await chrome.downloads.removeFile(item.id);
		return { originalDeleted: true };
	} catch (error) {
		return {
			originalDeleted: false,
			cleanupWarning: `论文已导入，但原下载文件删除失败：${readableError(error)}`,
		};
	}
}

async function importCompletedPdf(item) {
	if (processing.has(item.id)) return;
	processing.add(item.id);
	try {
		await saveLatest(item, "importing", { title: titleFromFilename(item.filename) });
		let status;
		try {
			status = await connectorStatus();
		} catch {
			await saveLatest(item, "ignored", { error: "Paper Agent 未运行，已忽略这次 PDF 下载" });
			return;
		}
		const result = await responseJson(
			await fetch(`${CONNECTOR_URL}/api/connector/capture-path`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					localPath: item.filename,
					metadata: captureMetadata(item),
					namespace: status.defaultNamespace,
				}),
			}),
		);
		const cleanup = await removeOriginalDownload(item);
		await saveLatest(item, "succeeded", {
			recordId: result.record?.id,
			title: result.record?.title || titleFromFilename(item.filename),
			...cleanup,
		});
	} catch (error) {
		await saveLatest(item, "failed", { error: readableError(error) });
	} finally {
		processing.delete(item.id);
		await removeValue(downloadKey(item.id));
	}
}

async function handleDownload(item) {
	if (!item || item.byExtensionId === chrome.runtime.id || !looksLikePdf(item)) return;
	if (item.state === "complete") {
		await importCompletedPdf(item);
		return;
	}
	if (item.state === "interrupted") {
		await saveLatest(item, "failed", { error: "PDF 下载已中断" });
		await removeValue(downloadKey(item.id));
		return;
	}
	await saveLatest(item, "downloading", { title: titleFromFilename(item.filename) });
	await saveValue(downloadKey(item.id), { downloadId: item.id, startedAt: Date.now() });
}

async function findDownload(downloadId) {
	const [item] = await chrome.downloads.search({ id: downloadId });
	return item;
}

async function recoverBackgroundState() {
	const values = await chrome.storage.session.get(null);
	for (const [key, value] of Object.entries(values)) {
		if (!key.startsWith(DOWNLOAD_PREFIX)) continue;
		const item = await findDownload(value.downloadId);
		if (item) await handleDownload(item);
		else await removeValue(key);
	}
}

const ready = recoverBackgroundState();

chrome.downloads.onCreated.addListener((item) => {
	void ready.then(() => handleDownload(item));
});

chrome.downloads.onChanged.addListener((delta) => {
	if (!delta.state?.current || !["complete", "interrupted"].includes(delta.state.current)) return;
	void ready.then(async () => {
		const item = await findDownload(delta.id);
		if (item) await handleDownload(item);
	});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type !== "paper-agent:auto-capture-status") return false;
	void ready.then(() => storedValue(LATEST_KEY)).then((value) => sendResponse(value || {}));
	return true;
});

globalThis.PaperAgentConnectorBackground = {
	captureStatus: () => storedValue(LATEST_KEY),
	handleDownload,
	recoverBackgroundState,
};
