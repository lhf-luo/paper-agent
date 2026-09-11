import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { isPrivateAddress } from "./network-address.ts";
import { getConfiguredProxy } from "./network-proxy-config.ts";

const PYTHON_DOWNLOAD_SCRIPT = `
import sys, urllib.request, ssl
url = sys.argv[1]
proxy = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0
handlers = []
if proxy:
    handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
opener = urllib.request.build_opener(*handlers)
req = urllib.request.Request(url, headers={
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/pdf,*/*;q=0.8',
})
try:
    resp = opener.open(req, timeout=timeout)
    sys.stdout.buffer.write(resp.read())
except Exception as exc:
    sys.stderr.write(str(exc))
    sys.exit(1)
`;

/**
 * 用系统 Python(标准库 urllib)下载文件内容。
 *
 * 用途: 部分站点(如 arXiv)对 Node 的 TLS 指纹返回反爬挑战页,
 * 而标准 Python 客户端指纹与 curl 类似, 下载更稳定。
 * 仅在 arXiv/export.arxiv.org 等已知域名上启用, 失败时调用方回退到 Node 通道。
 */
export async function downloadViaPython(
	url: URL,
	options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Uint8Array> {
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Python download requires http(s) URL");
	}
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	) {
		throw new Error(`Private hostname is not allowed: ${hostname}`);
	}
	if (isIP(hostname) && isPrivateAddress(hostname)) {
		throw new Error(`Private or reserved address is not allowed: ${hostname}`);
	}
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
	const proxy = getConfiguredProxy()?.href ?? "";
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.env.PAPER_AGENT_PYTHON_BIN ?? "python3",
			["-c", PYTHON_DOWNLOAD_SCRIPT, url.href, proxy, String(timeoutMs / 1000)],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const chunks: Buffer[] = [];
		let total = 0;
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`python download timeout after ${timeoutMs}ms`));
		}, timeoutMs + 5_000);
		child.stdout.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > maxBytes) {
				child.kill("SIGKILL");
				clearTimeout(timer);
				reject(new Error(`python download exceeded ${maxBytes} bytes`));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`python download failed (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ""}`));
				return;
			}
			const body = Buffer.concat(chunks);
			if (body.length === 0) {
				reject(new Error("python download returned an empty body"));
				return;
			}
			resolve(new Uint8Array(body));
		});
	});
}
