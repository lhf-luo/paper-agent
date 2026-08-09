import { extname } from "node:path";
import type { ArtifactCandidate, ArtifactSnapshot, ArtifactSourceMetadata } from "./literature-types.ts";
import { type AddressResolver, type Fetcher, fetchPublicUrl, readResponseBody } from "./network-security.ts";

export interface ArtifactNetworkOptions {
	signal?: AbortSignal;
	fetcher?: Fetcher;
	resolver?: AddressResolver;
}

export function inspectArtifactContent(
	candidate: ArtifactCandidate,
	response: Pick<Response, "headers">,
	body: Buffer,
	finalUrl = new URL(candidate.url),
): Pick<ArtifactSnapshot, "contentDisposition" | "contentType" | "contentValidation" | "detectedContentType"> {
	if (body.length === 0) throw new Error("artifact response body is empty");
	const contentType = (response.headers.get("content-type") ?? "application/octet-stream")
		.split(";", 1)[0]
		.trim()
		.toLowerCase();
	const contentDisposition = response.headers.get("content-disposition") ?? undefined;
	const prefix = body.subarray(0, 512);
	const textPrefix = prefix.toString("utf8").trimStart().toLowerCase();
	let detectedContentType = "application/octet-stream";
	if (body.subarray(0, 5).toString("ascii") === "%PDF-") detectedContentType = "application/pdf";
	else if (["504b0304", "504b0506", "504b0708"].includes(body.subarray(0, 4).toString("hex")))
		detectedContentType = "application/zip";
	else if (body.subarray(0, 2).toString("hex") === "1f8b") detectedContentType = "application/gzip";
	else if (body.subarray(0, 6).toString("hex") === "377abcaf271c") detectedContentType = "application/x-7z-compressed";
	else if (body.subarray(0, 3).toString("ascii") === "BZh") detectedContentType = "application/x-bzip2";
	else if (body.subarray(0, 6).toString("hex") === "fd377a585a00") detectedContentType = "application/x-xz";
	else if (body.length > 262 && body.subarray(257, 262).toString("ascii") === "ustar")
		detectedContentType = "application/x-tar";
	else if (textPrefix.startsWith("<!doctype html") || textPrefix.startsWith("<html"))
		detectedContentType = "text/html";
	else if (textPrefix.startsWith("{") || textPrefix.startsWith("[")) {
		try {
			JSON.parse(body.toString("utf8"));
			detectedContentType = "application/json";
		} catch {
			detectedContentType = "text/plain";
		}
	} else if (!prefix.includes(0)) detectedContentType = "text/plain";

	const extension = extname(finalUrl.pathname).toLowerCase();
	const expectedByExtension: Record<string, string> = {
		".pdf": "application/pdf",
		".zip": "application/zip",
		".gz": "application/gzip",
		".tgz": "application/gzip",
		".7z": "application/x-7z-compressed",
		".bz2": "application/x-bzip2",
		".xz": "application/x-xz",
		".tar": "application/x-tar",
	};
	const expected = expectedByExtension[extension];
	const unverifiedLegacyTar =
		extension === ".tar" && ["application/octet-stream", "text/plain"].includes(detectedContentType);
	if (expected && detectedContentType !== expected && !unverifiedLegacyTar) {
		throw new Error(`artifact content does not match ${extension}: detected ${detectedContentType}`);
	}
	const declaredFamily = new Map([
		["application/pdf", "application/pdf"],
		["application/zip", "application/zip"],
		["application/x-zip-compressed", "application/zip"],
		["application/gzip", "application/gzip"],
		["application/x-gzip", "application/gzip"],
		["application/x-tar", "application/x-tar"],
	]);
	const declaredExpected = declaredFamily.get(contentType);
	if (
		declaredExpected &&
		detectedContentType !== declaredExpected &&
		!(declaredExpected === "application/x-tar" && unverifiedLegacyTar)
	) {
		throw new Error(`artifact Content-Type ${contentType} does not match detected ${detectedContentType}`);
	}
	if (detectedContentType === "text/html" && candidate.kind !== "project") {
		throw new Error("artifact URL resolved to an HTML landing page instead of downloadable content");
	}
	return {
		contentType,
		detectedContentType,
		contentDisposition,
		contentValidation:
			detectedContentType === "application/octet-stream" || unverifiedLegacyTar ? "unverified" : "validated",
	};
}

async function fetchJsonMetadata(url: URL, options: ArtifactNetworkOptions): Promise<unknown> {
	const fetched = await fetchPublicUrl(url, {
		...options,
		init: { headers: { accept: "application/json" } },
	});
	if (!fetched.response.ok) throw new Error(`metadata HTTP ${fetched.response.status}`);
	return JSON.parse((await readResponseBody(fetched.response, 2 * 1024 * 1024)).toString("utf8"));
}

export async function resolveArtifactSourceMetadata(
	candidate: ArtifactCandidate,
	options: ArtifactNetworkOptions = {},
): Promise<ArtifactSourceMetadata | undefined> {
	const source = new URL(candidate.url);
	const host = source.hostname.toLowerCase();
	const parts = source.pathname.split("/").filter(Boolean);
	if (host === "github.com" && parts.length >= 2) {
		const recordId = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
		const apiUrl = new URL(`https://api.github.com/repos/${recordId}`);
		const value = (await fetchJsonMetadata(apiUrl, options)) as {
			default_branch?: string;
			license?: { spdx_id?: string } | null;
			updated_at?: string;
		};
		return {
			provider: "github",
			recordId,
			apiUrl: apiUrl.href,
			version: value.default_branch,
			license: value.license?.spdx_id ?? undefined,
			publishedAt: value.updated_at,
		};
	}
	if (host.endsWith("zenodo.org")) {
		const marker = parts.findIndex((part) => part === "record" || part === "records");
		const recordId = marker >= 0 ? parts[marker + 1] : undefined;
		if (!recordId || !/^\d+$/.test(recordId)) return undefined;
		const apiUrl = new URL(`https://zenodo.org/api/records/${recordId}`);
		const value = (await fetchJsonMetadata(apiUrl, options)) as {
			doi?: string;
			metadata?: { version?: string; publication_date?: string; license?: { id?: string } | string };
			files?: Array<{ key?: string; size?: number; checksum?: string; links?: { self?: string; content?: string } }>;
		};
		return {
			provider: "zenodo",
			recordId,
			apiUrl: apiUrl.href,
			version: value.metadata?.version,
			doi: value.doi,
			license: typeof value.metadata?.license === "string" ? value.metadata.license : value.metadata?.license?.id,
			publishedAt: value.metadata?.publication_date,
			files: value.files
				?.filter((file) => file.key && (file.links?.content || file.links?.self))
				.map((file) => ({
					name: file.key ?? "artifact",
					url: file.links?.content ?? file.links?.self ?? "",
					bytes: file.size,
					checksum: file.checksum,
				})),
		};
	}
	if (host === "figshare.com" || host.endsWith(".figshare.com")) {
		const recordId = [...parts].reverse().find((part) => /^\d+$/.test(part));
		if (!recordId) return undefined;
		const apiUrl = new URL(`https://api.figshare.com/v2/articles/${recordId}`);
		const value = (await fetchJsonMetadata(apiUrl, options)) as {
			doi?: string;
			version?: number;
			published_date?: string;
			license?: { name?: string; url?: string };
			files?: Array<{ name?: string; download_url?: string; size?: number; supplied_md5?: string }>;
		};
		return {
			provider: "figshare",
			recordId,
			apiUrl: apiUrl.href,
			version: value.version === undefined ? undefined : String(value.version),
			doi: value.doi,
			license: value.license?.name ?? value.license?.url,
			publishedAt: value.published_date,
			files: value.files
				?.filter((file) => file.name && file.download_url)
				.map((file) => ({
					name: file.name ?? "artifact",
					url: file.download_url ?? "",
					bytes: file.size,
					checksum: file.supplied_md5,
				})),
		};
	}
	return undefined;
}
