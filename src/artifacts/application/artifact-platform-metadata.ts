import type {
	ArtifactCandidate,
	ArtifactSourceFile,
	ArtifactSourceMetadata,
} from "../../literature/domain/literature-types.ts";
import type { AddressResolver } from "../../shared/infrastructure/network-address.ts";
import { readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { type Fetcher, fetchPublicUrl } from "../../shared/infrastructure/network-security.ts";

interface MetadataNetworkOptions {
	signal?: AbortSignal;
	fetcher?: Fetcher;
	resolver?: AddressResolver;
}

async function fetchJson(url: URL, options: MetadataNetworkOptions): Promise<unknown> {
	const fetched = await fetchPublicUrl(url, {
		...options,
		init: { headers: { accept: "application/json" } },
	});
	if (!fetched.response.ok) throw new Error(`metadata HTTP ${fetched.response.status}`);
	return JSON.parse((await readResponseBody(fetched.response, 2 * 1024 * 1024)).toString("utf8"));
}

function encodedPath(path: string): string {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

async function huggingFaceMetadata(
	parts: string[],
	options: MetadataNetworkOptions,
): Promise<ArtifactSourceMetadata | undefined> {
	if (parts[0] !== "datasets" || parts.length < 3) return undefined;
	const recordId = `${parts[1]}/${parts[2]}`;
	const apiUrl = new URL(`https://huggingface.co/api/datasets/${recordId}`);
	const value = (await fetchJson(apiUrl, options)) as {
		sha?: string;
		lastModified?: string;
		description?: string;
		siblings?: Array<{ rfilename?: string; size?: number; lfs?: { sha256?: string; size?: number } }>;
	};
	const revision = value.sha ?? "main";
	const files = (value.siblings ?? []).slice(0, 500).flatMap((file): ArtifactSourceFile[] => {
		if (!file.rfilename || file.rfilename.startsWith(".")) return [];
		return [
			{
				name: file.rfilename,
				url: `https://huggingface.co/datasets/${recordId}/resolve/${encodeURIComponent(revision)}/${encodedPath(file.rfilename)}`,
				bytes: file.lfs?.size ?? file.size,
				checksum: file.lfs?.sha256 ? `sha256:${file.lfs.sha256}` : undefined,
			},
		];
	});
	return {
		provider: "huggingface",
		recordId,
		apiUrl: apiUrl.href,
		version: revision,
		publishedAt: value.lastModified,
		description: value.description,
		files,
	};
}

async function osfMetadata(
	parts: string[],
	options: MetadataNetworkOptions,
): Promise<ArtifactSourceMetadata | undefined> {
	const recordId = parts[0];
	if (!recordId || !/^[a-z0-9]{5,12}$/i.test(recordId)) return undefined;
	const apiUrl = new URL(`https://api.osf.io/v2/nodes/${recordId}/files/`);
	const providers = (await fetchJson(apiUrl, options)) as {
		data?: Array<{ relationships?: { files?: { links?: { related?: { href?: string } } } } }>;
	};
	const files: ArtifactSourceFile[] = [];
	for (const provider of (providers.data ?? []).slice(0, 10)) {
		const related = provider.relationships?.files?.links?.related?.href;
		if (!related) continue;
		const listing = (await fetchJson(new URL(related), options)) as {
			data?: Array<{
				attributes?: { name?: string; size?: number; kind?: string };
				links?: { download?: string };
			}>;
		};
		for (const item of listing.data ?? []) {
			if (item.attributes?.kind !== "file" || !item.attributes.name || !item.links?.download) continue;
			files.push({ name: item.attributes.name, url: item.links.download, bytes: item.attributes.size });
			if (files.length >= 500) break;
		}
		if (files.length >= 500) break;
	}
	return { provider: "osf", recordId, apiUrl: apiUrl.href, files };
}

async function dataverseMetadata(
	source: URL,
	options: MetadataNetworkOptions,
): Promise<ArtifactSourceMetadata | undefined> {
	const persistentId = source.searchParams.get("persistentId");
	if (!persistentId || !/^doi:/i.test(persistentId)) return undefined;
	const apiUrl = new URL("/api/v1/datasets/:persistentId/", source.origin);
	apiUrl.searchParams.set("persistentId", persistentId);
	const value = (await fetchJson(apiUrl, options)) as {
		data?: {
			persistentUrl?: string;
			latestVersion?: {
				versionNumber?: number;
				versionMinorNumber?: number;
				releaseTime?: string;
				files?: Array<{
					dataFile?: {
						id?: number;
						filename?: string;
						filesize?: number;
						checksum?: { type?: string; value?: string };
					};
				}>;
			};
		};
	};
	const version = value.data?.latestVersion;
	const files = (version?.files ?? []).slice(0, 500).flatMap((item): ArtifactSourceFile[] => {
		const file = item.dataFile;
		if (!file?.id || !file.filename) return [];
		const checksum =
			file.checksum?.type && file.checksum.value ? `${file.checksum.type}:${file.checksum.value}` : undefined;
		return [
			{
				name: file.filename,
				url: new URL(`/api/access/datafile/${file.id}`, source.origin).href,
				bytes: file.filesize,
				checksum,
			},
		];
	});
	return {
		provider: "dataverse",
		recordId: persistentId,
		apiUrl: apiUrl.href,
		version:
			version?.versionNumber === undefined
				? undefined
				: `${version.versionNumber}.${version.versionMinorNumber ?? 0}`,
		doi: persistentId.replace(/^doi:/i, ""),
		publishedAt: version?.releaseTime,
		files,
	};
}

export async function resolveAdditionalArtifactMetadata(
	candidate: ArtifactCandidate,
	options: MetadataNetworkOptions,
): Promise<ArtifactSourceMetadata | undefined> {
	const source = new URL(candidate.url);
	const host = source.hostname.toLowerCase();
	const parts = source.pathname.split("/").filter(Boolean);
	if (host === "huggingface.co") return huggingFaceMetadata(parts, options);
	if (host === "osf.io") return osfMetadata(parts, options);
	if (host.includes("dataverse") || source.pathname.endsWith("dataset.xhtml")) {
		return dataverseMetadata(source, options);
	}
	return undefined;
}
