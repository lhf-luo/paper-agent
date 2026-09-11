import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactCandidate, ArtifactManifest } from "../../literature/domain/literature-types.ts";

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export function isWithinRoot(root: string, path: string): boolean {
	const relativePath = relative(resolve(root), resolve(path));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}

export async function readExistingManifest(path: string, pdfSha256: string): Promise<ArtifactManifest | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as ArtifactManifest).schemaVersion === 1 &&
			(parsed as ArtifactManifest).pdfSha256 === pdfSha256 &&
			Array.isArray((parsed as ArtifactManifest).acquisitions)
		) {
			return parsed as ArtifactManifest;
		}
		return undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function acquisitionRoot(manifest: ArtifactManifest): string {
	return join(dirname(manifest.pdfPath), "artifacts");
}

function safeDirectorySegment(value: string, fallback: string): string {
	const cleaned = value
		.normalize("NFKC")
		.replace(/\.git$/i, "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/[. -]+$/g, "")
		.slice(0, 64);
	return !cleaned || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? fallback : cleaned;
}

function decodedPathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function artifactDirectoryNames(candidate: ArtifactCandidate): string[] {
	const url = new URL(candidate.url);
	const parts = url.pathname.split("/").filter(Boolean).map(decodedPathSegment);
	const project = safeDirectorySegment(parts.at(-1) ?? "", candidate.id);
	const owner = safeDirectorySegment(parts.at(-2) ?? url.hostname, url.hostname);
	const shortId = candidate.id.replace(/^artifact-/, "").slice(0, 8) || "artifact";
	return [...new Set([project, `${project}-${owner}`, `${project}-${shortId}`])];
}
