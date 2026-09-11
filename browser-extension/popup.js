const CONNECTOR_URL = "http://127.0.0.1:43127";

const elements = {
	connection: document.querySelector("#connection"),
	namespace: document.querySelector("#namespace"),
	result: document.querySelector("#result"),
};

async function responseJson(response) {
	const value = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
	return value;
}

async function latestCapture() {
	return (await chrome.runtime.sendMessage({ type: "paper-agent:auto-capture-status" })) || {};
}

function showLatest(value) {
	elements.result.className = "result";
	if (!value.state) {
		elements.result.textContent = "暂无捕捉记录";
		return;
	}
	if (value.state === "downloading") {
		elements.result.className = "result muted";
		elements.result.textContent = `正在下载：${value.title || "PDF"}`;
		return;
	}
	if (value.state === "importing") {
		elements.result.className = "result importing";
		elements.result.textContent = `正在导入：${value.title || "PDF"}`;
		return;
	}
	if (value.state === "succeeded") {
		elements.result.className = value.cleanupWarning ? "result warning" : "result";
		elements.result.textContent = value.cleanupWarning
			? `最近导入：${value.title || "论文"}；${value.cleanupWarning}`
			: `最近导入：${value.title || "论文"}（原下载文件已删除）`;
		return;
	}
	elements.result.className = value.state === "failed" ? "result error" : "result muted";
	elements.result.textContent = value.error || "最近一次 PDF 下载未导入";
}

async function initialize() {
	try {
		const status = await responseJson(await fetch(`${CONNECTOR_URL}/api/connector/ping`));
		elements.connection.textContent = "Paper Agent 已连接";
		elements.connection.className = "status online";
		elements.namespace.textContent = status.defaultNamespace;
	} catch {
		elements.connection.textContent = "Paper Agent 未启动或连接端口不可用";
		elements.connection.className = "status offline";
		elements.namespace.textContent = "-";
	}
	try {
		showLatest(await latestCapture());
	} catch (error) {
		elements.result.className = "result error";
		elements.result.textContent = error instanceof Error ? error.message : String(error);
	}
}

void initialize();
window.setInterval(() => {
	void latestCapture()
		.then(showLatest)
		.catch(() => undefined);
}, 750);
