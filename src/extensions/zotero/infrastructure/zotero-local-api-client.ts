import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import type { ZoteroApiItem, ZoteroCollectionEntry, ZoteroItemData, ZoteroStatus } from "../domain/zotero-types.ts";

const HOST = "127.0.0.1";
const PORT = 23119;
const API_PREFIX = "/api";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const PAGE_SIZE = 100;

export class ZoteroLocalApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

interface LocalResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
}

interface ZoteroClientCredentials {
	serverId?: string;
	apiKey?: string;
}

function localRequest(
	method: string,
	path: string,
	options: { headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number } = {},
): Promise<LocalResponse> {
	return new Promise((resolve, reject) => {
		const connection = request(
			{
				host: HOST,
				port: PORT,
				method,
				path: `${API_PREFIX}${path}`,
				headers: options.headers,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk) => {
					bytes += Buffer.byteLength(chunk);
					if (bytes > MAX_JSON_BYTES) {
						connection.destroy(new Error("Zotero response exceeded 64 MB"));
						return;
					}
					chunks.push(Buffer.from(chunk));
				});
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
				);
			},
		);
		connection.setTimeout(options.timeoutMs ?? 30_000, () =>
			connection.destroy(new Error("Zotero request timed out")),
		);
		connection.on("error", reject);
		if (options.body) connection.write(options.body);
		connection.end();
	});
}

function header(response: LocalResponse, name: string): string | undefined {
	const value = response.headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

function errorMessage(response: LocalResponse): string {
	const text = response.body.toString("utf8").trim();
	if (!text) return `Zotero Local API returned HTTP ${response.status}`;
	try {
		const value = JSON.parse(text) as { error?: string; message?: string; denied?: boolean };
		if (value.denied) return "Zotero 写入授权被拒绝";
		return value.message ?? value.error ?? text;
	} catch {
		return text;
	}
}

function requireSuccess(response: LocalResponse, expected: number[] = [200]): LocalResponse {
	if (expected.includes(response.status)) return response;
	const code =
		response.status === 401
			? "authorization-required"
			: response.status === 403
				? "local-api-disabled-or-denied"
				: response.status === 412
					? "server-id-changed"
					: "zotero-http-error";
	throw new ZoteroLocalApiError(response.status, code, errorMessage(response));
}

function parseJson<T>(response: LocalResponse): T {
	requireSuccess(response);
	try {
		return JSON.parse(response.body.toString("utf8")) as T;
	} catch {
		throw new ZoteroLocalApiError(502, "invalid-json", "Zotero 返回了无效 JSON");
	}
}

async function pagedJson<T>(path: string, headers: Record<string, string>): Promise<T[]> {
	const values: T[] = [];
	for (let start = 0; start < 10_000; start += PAGE_SIZE) {
		const separator = path.includes("?") ? "&" : "?";
		const page = parseJson<T[]>(
			await localRequest("GET", `${path}${separator}limit=${PAGE_SIZE}&start=${start}`, { headers }),
		);
		values.push(...page);
		if (page.length < PAGE_SIZE) return values;
	}
	throw new Error("Zotero 文库超过 10000 条，请先使用关键词缩小范围");
}

function collectionPath(key: string, byKey: Map<string, { name: string; parentKey?: string }>): string[] {
	const path: string[] = [];
	const seen = new Set<string>();
	let current: string | undefined = key;
	while (current && !seen.has(current)) {
		seen.add(current);
		const entry = byKey.get(current);
		if (!entry) break;
		path.unshift(entry.name);
		current = entry.parentKey;
	}
	return path;
}

export class ZoteroLocalApiClient {
	private credentials: ZoteroClientCredentials;

	constructor(credentials: ZoteroClientCredentials = {}) {
		this.credentials = { ...credentials };
	}

	setCredentials(credentials: ZoteroClientCredentials): void {
		this.credentials = { ...credentials };
	}

	private headers(write = false, contentType?: string): Record<string, string> {
		const headers: Record<string, string> = {
			"Zotero-API-Version": "3",
			"Zotero-Allowed-Request": "1",
			Accept: "application/json",
		};
		if (write && this.credentials.serverId) headers["Zotero-Server-ID"] = this.credentials.serverId;
		if (write && this.credentials.apiKey) headers["Zotero-API-Key"] = this.credentials.apiKey;
		if (contentType) headers["Content-Type"] = contentType;
		return headers;
	}

	async status(): Promise<ZoteroStatus> {
		let response: LocalResponse;
		try {
			response = await localRequest("GET", "/", {
				headers: { "Zotero-API-Version": "3", "Zotero-Allowed-Request": "1", Accept: "application/json" },
				timeoutMs: 3_000,
			});
		} catch (error) {
			return {
				running: false,
				localApiEnabled: false,
				writeAuthorized: false,
				message: `未连接到 Zotero：${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const serverId = header(response, "zotero-server-id");
		if (response.status === 403) {
			return {
				running: true,
				localApiEnabled: false,
				writeAuthorized: false,
				serverId,
				message: "Zotero 已运行，但本地 API 未启用",
			};
		}
		if (response.status !== 200) {
			return {
				running: true,
				localApiEnabled: false,
				writeAuthorized: false,
				serverId,
				message: errorMessage(response),
			};
		}
		return {
			running: true,
			localApiEnabled: true,
			writeAuthorized: Boolean(
				this.credentials.apiKey && this.credentials.serverId && this.credentials.serverId === serverId,
			),
			serverId,
			message: this.credentials.apiKey ? "Zotero 已连接" : "Zotero 可读取，写入需要授权",
		};
	}

	async authorize(serverId: string): Promise<{ key: string; remember: boolean; serverId: string }> {
		const body = Buffer.from(JSON.stringify({ appName: "Paper Agent" }));
		const response = requireSuccess(
			await localRequest("POST", "/local/authorize", {
				headers: {
					...this.headers(false, "application/json"),
					"Zotero-Server-ID": serverId,
					"Content-Length": String(body.length),
				},
				body,
			}),
		);
		const result = JSON.parse(response.body.toString("utf8")) as { key?: string; remember?: boolean };
		if (!result.key) throw new ZoteroLocalApiError(502, "missing-key", "Zotero 未返回本地 API 密钥");
		this.credentials = { apiKey: result.key, serverId };
		return { key: result.key, remember: Boolean(result.remember), serverId };
	}

	async listCollections(): Promise<ZoteroCollectionEntry[]> {
		const rows = await pagedJson<{
			key: string;
			version: number;
			data: { name: string; parentCollection?: string | false };
		}>("/users/0/collections", this.headers());
		const byKey = new Map(
			rows.map((row) => [
				row.key,
				{
					name: row.data.name,
					parentKey: typeof row.data.parentCollection === "string" ? row.data.parentCollection : undefined,
				},
			]),
		);
		return rows.map((row) => ({
			key: row.key,
			version: row.version,
			name: row.data.name,
			parentKey: typeof row.data.parentCollection === "string" ? row.data.parentCollection : undefined,
			path: collectionPath(row.key, byKey),
		}));
	}

	async listItems(query?: string): Promise<ZoteroApiItem[]> {
		const params = new URLSearchParams();
		params.set("include", "data");
		if (query?.trim()) params.set("q", query.trim());
		return (await pagedJson<ZoteroApiItem>(`/users/0/items/top?${params.toString()}`, this.headers())).filter(
			(item) => item.data.itemType !== "attachment" && item.data.itemType !== "note",
		);
	}

	async getItem(key: string): Promise<ZoteroApiItem> {
		return parseJson<ZoteroApiItem>(
			await localRequest("GET", `/users/0/items/${encodeURIComponent(key)}`, { headers: this.headers() }),
		);
	}

	async getChildren(key: string): Promise<ZoteroApiItem[]> {
		return pagedJson<ZoteroApiItem>(`/users/0/items/${encodeURIComponent(key)}/children`, this.headers());
	}

	async readAttachment(key: string): Promise<{ body: Buffer; path: string }> {
		const response = requireSuccess(
			await localRequest("GET", `/users/0/items/${encodeURIComponent(key)}/file/view/url`, {
				headers: { ...this.headers(), Accept: "text/plain" },
			}),
		);
		const location = response.body.toString("utf8").trim();
		if (!location.startsWith("file:")) throw new Error("Zotero PDF 附件不是本地可读文件");
		const path = fileURLToPath(location);
		if ((await stat(path)).size > MAX_PDF_BYTES) throw new Error("Zotero PDF 附件超过 100 MB 限制");
		const body = await readFile(path);
		if (body.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Zotero 附件不是有效 PDF");
		return { body, path };
	}

	async itemTemplate(itemType: string, linkMode?: string): Promise<ZoteroItemData> {
		const params = new URLSearchParams({ itemType });
		if (linkMode) params.set("linkMode", linkMode);
		const response = await localRequest("GET", `/items/new?${params.toString()}`, { headers: this.headers() });
		if (response.status === 404) {
			return {
				itemType,
				...(linkMode ? { linkMode } : {}),
				creators: [],
				tags: [],
				collections: [],
				relations: {},
			};
		}
		return parseJson<ZoteroItemData>(response);
	}

	private async deleteItem(key: string, version: number): Promise<void> {
		requireSuccess(
			await localRequest("DELETE", `/users/0/items/${encodeURIComponent(key)}`, {
				headers: {
					...this.headers(true),
					"If-Unmodified-Since-Version": String(version),
				},
			}),
			[204],
		);
	}

	async createObjects(kind: "items" | "collections", values: unknown[]): Promise<Record<string, ZoteroApiItem>> {
		const body = Buffer.from(JSON.stringify(values));
		const response = parseJson<{
			successful?: Record<string, ZoteroApiItem>;
			failed?: Record<string, { message: string }>;
		}>(
			await localRequest("POST", `/users/0/${kind}`, {
				headers: { ...this.headers(true, "application/json"), "Content-Length": String(body.length) },
				body,
			}),
		);
		const failure = Object.values(response.failed ?? {})[0];
		if (failure) throw new Error(failure.message);
		return response.successful ?? {};
	}

	async updateItem(key: string, data: ZoteroItemData): Promise<ZoteroApiItem> {
		const body = Buffer.from(JSON.stringify(data));
		const response = requireSuccess(
			await localRequest("PUT", `/users/0/items/${encodeURIComponent(key)}`, {
				headers: { ...this.headers(true, "application/json"), "Content-Length": String(body.length) },
				body,
			}),
			[204],
		);
		return { key, version: Number(header(response, "last-modified-version") ?? data.version), data };
	}

	async uploadPdf(parentKey: string, filename: string, body: Buffer): Promise<{ key: string; version: number }> {
		const template = await this.itemTemplate("attachment", "imported_file");
		const attachment = {
			...template,
			itemType: "attachment",
			parentItem: parentKey,
			linkMode: "imported_file",
			title: filename.replace(/\.pdf$/i, ""),
			contentType: "application/pdf",
			filename,
		};
		const created = Object.values(await this.createObjects("items", [attachment]))[0];
		if (!created?.key) throw new Error("Zotero 未创建 PDF 附件条目");
		try {
			const md5 = createHash("md5").update(body).digest("hex");
			const form = new URLSearchParams({ md5, filename, filesize: String(body.length), mtime: String(Date.now()) });
			const authorize = parseJson<{
				exists?: number;
				url?: string;
				uploadKey?: string;
				contentType?: string;
				prefix?: string;
				suffix?: string;
			}>(
				await localRequest("POST", `/users/0/items/${created.key}/file`, {
					headers: {
						...this.headers(true, "application/x-www-form-urlencoded"),
						"If-None-Match": "*",
						"Content-Length": String(Buffer.byteLength(form.toString())),
					},
					body: Buffer.from(form.toString()),
				}),
			);
			if (!authorize.exists) {
				if (!authorize.url || !authorize.uploadKey) throw new Error("Zotero 未返回文件上传地址");
				const target = new URL(authorize.url);
				if (target.hostname !== HOST && target.hostname !== "localhost")
					throw new Error("Zotero 返回了非本地上传地址");
				const uploadBody = Buffer.concat([
					Buffer.from(authorize.prefix ?? ""),
					body,
					Buffer.from(authorize.suffix ?? ""),
				]);
				const uploaded = await localRequest("POST", `${target.pathname.replace(/^\/api/, "")}${target.search}`, {
					headers: {
						"Content-Type": authorize.contentType ?? "application/octet-stream",
						"Content-Length": String(uploadBody.length),
					},
					body: uploadBody,
					timeoutMs: 120_000,
				});
				requireSuccess(uploaded, [201]);
				const register = new URLSearchParams({ upload: authorize.uploadKey });
				requireSuccess(
					await localRequest("POST", `/users/0/items/${created.key}/file`, {
						headers: {
							...this.headers(true, "application/x-www-form-urlencoded"),
							"If-None-Match": "*",
							"Content-Length": String(Buffer.byteLength(register.toString())),
						},
						body: Buffer.from(register.toString()),
					}),
					[204],
				);
			}
		} catch (error) {
			await this.deleteItem(created.key, created.version).catch(() => undefined);
			throw error;
		}
		return { key: created.key, version: created.version };
	}
}
