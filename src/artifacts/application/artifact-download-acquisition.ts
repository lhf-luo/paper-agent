import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ArtifactCandidate,
	ArtifactSnapshot,
	ArtifactSourceFile,
	ArtifactSourceMetadata,
} from "../../literature/domain/literature-types.ts";
import { readResponseBody, safeDownloadName } from "../../shared/infrastructure/network-content.ts";
import { fetchPublicUrl } from "../../shared/infrastructure/network-security.ts";
import { exists } from "./artifact-acquisition-files.ts";
import { type ArtifactNetworkOptions, inspectArtifactContent } from "./artifact-content.ts";
import { sha256File } from "./artifact-discovery.ts";

export async function downloadArtifact(
	candidate: ArtifactCandidate,
	root: string,
	maxBytes: number,
	metadata: ArtifactSourceMetadata | undefined,
	metadataError: string | undefined,
	metadataFile?: ArtifactSourceFile,
	signal?: AbortSignal,
	network: Omit<ArtifactNetworkOptions, "signal"> = {},
): Promise<ArtifactSnapshot> {
	if (metadataFile?.bytes !== undefined && metadataFile.bytes > maxBytes) {
		throw new Error(`artifact metadata declares ${metadataFile.bytes} bytes, above the ${maxBytes} byte limit`);
	}
	const requested = new URL(candidate.url);
	if (requested.protocol !== "https:") throw new Error("Artifact downloads must use public HTTPS URLs");
	const fetched = await fetchPublicUrl(requested, { signal, ...network, requireHttps: true });
	if (!fetched.response.ok) throw new Error(`HTTP ${fetched.response.status}`);
	const body = await readResponseBody(fetched.response, maxBytes);
	if (metadataFile?.bytes !== undefined && metadataFile.bytes !== body.length) {
		throw new Error(
			`artifact size does not match source metadata: expected=${metadataFile.bytes} actual=${body.length}`,
		);
	}
	if (metadataFile?.checksum) {
		const declared = metadataFile.checksum.trim().toLowerCase();
		const separator = declared.indexOf(":");
		const normalizedAlgorithm = separator >= 0 ? declared.slice(0, separator).replaceAll("-", "") : undefined;
		const algorithm =
			normalizedAlgorithm ??
			({ 32: "md5", 40: "sha1", 64: "sha256", 128: "sha512" } as Record<number, string>)[declared.length];
		const expected = separator >= 0 ? declared.slice(separator + 1) : declared;
		const expectedLengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };
		if (
			!algorithm ||
			!expectedLengths[algorithm] ||
			!new RegExp(`^[a-f0-9]{${expectedLengths[algorithm]}}$`).test(expected)
		) {
			throw new Error(`artifact metadata declares an unsupported or malformed checksum: ${metadataFile.checksum}`);
		}
		const actual = createHash(algorithm).update(body).digest("hex");
		if (actual !== expected) {
			throw new Error(
				`artifact checksum does not match source metadata: ${algorithm} expected=${expected} actual=${actual}`,
			);
		}
	}
	const content = inspectArtifactContent(candidate, fetched.response, body, fetched.finalUrl);
	const sha256 = createHash("sha256").update(body).digest("hex");
	const filename = `${candidate.id}-${safeDownloadName(fetched.finalUrl)}`;
	const destination = join(root, "downloads", filename);
	await mkdir(dirname(destination), { recursive: true });
	if (await exists(destination)) {
		const existingSha256 = await sha256File(destination);
		if (existingSha256 !== sha256) {
			throw new Error(`existing destination SHA-256 mismatch: existing=${existingSha256} fetched=${sha256}`);
		}
		return {
			candidateId: candidate.id,
			sourceUrl: candidate.url,
			status: "skipped",
			localPath: destination,
			retrievedAt: new Date().toISOString(),
			finalUrl: fetched.finalUrl.href,
			sha256,
			bytes: body.length,
			...content,
			metadata,
			metadataFile,
			metadataError,
			failureReason: "destination already exists",
		};
	}
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, body, { flag: "wx" });
		await rename(temporary, destination);
	} catch (error) {
		try {
			await unlink(temporary);
		} catch {
			// Best-effort cleanup of a bounded partial file.
		}
		throw error;
	}
	return {
		candidateId: candidate.id,
		sourceUrl: candidate.url,
		status: "downloaded",
		localPath: destination,
		retrievedAt: new Date().toISOString(),
		finalUrl: fetched.finalUrl.href,
		sha256,
		bytes: body.length,
		...content,
		metadata,
		metadataFile,
		metadataError,
	};
}

export function isMetadataLandingPage(candidate: ArtifactCandidate, metadata: ArtifactSourceMetadata): boolean {
	const source = new URL(candidate.url);
	const parts = source.pathname.split("/").filter(Boolean);
	if (metadata.provider === "zenodo") {
		const marker = parts.findIndex((part) => part === "record" || part === "records");
		return marker >= 0 && parts.length === marker + 2;
	}
	return (
		["dataverse", "huggingface", "osf"].includes(metadata.provider) ||
		(metadata.provider === "figshare" &&
			(source.hostname === "figshare.com" || source.hostname.endsWith(".figshare.com")))
	);
}

export function metadataFileCandidate(parent: ArtifactCandidate, file: ArtifactSourceFile): ArtifactCandidate {
	const url = new URL(file.url);
	return {
		id: `${parent.id}-file-${createHash("sha256").update(url.href).digest("hex").slice(0, 12)}`,
		url: url.href,
		kind: parent.kind,
		host: url.hostname.toLowerCase(),
		parentCandidateId: parent.id,
		sources: parent.sources,
		confidence: "high",
	};
}

export async function resolveDoiCandidate(
	candidate: ArtifactCandidate,
	network: ArtifactNetworkOptions,
): Promise<ArtifactCandidate> {
	const fetched = await fetchPublicUrl(new URL(candidate.url), {
		...network,
		init: { headers: { accept: "text/html,application/json,application/octet-stream" } },
	});
	if (!fetched.response.ok) throw new Error(`DOI resolution returned HTTP ${fetched.response.status}`);
	await fetched.response.body?.cancel();
	if (fetched.finalUrl.hostname.toLowerCase() === "doi.org") {
		throw new Error("DOI resolver did not return an external artifact location");
	}
	const host = fetched.finalUrl.hostname.toLowerCase();
	const kind = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"].includes(host)
		? "repository"
		: host.endsWith("zenodo.org") || host === "figshare.com" || host.endsWith(".figshare.com")
			? "dataset"
			: candidate.kind === "unknown"
				? "project"
				: candidate.kind;
	return {
		...candidate,
		url: fetched.finalUrl.href,
		host,
		kind,
	};
}
