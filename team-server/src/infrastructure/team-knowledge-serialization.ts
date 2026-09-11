import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArtifactManifest, ArtifactSnapshot } from "../protocol/literature-types.ts";

export function safeSegment(value: string, label: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
	return value;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		try {
			await unlink(temporary);
		} catch {
			/* Preserve the write error. */
		}
		throw error;
	}
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function sanitizeSnapshot(snapshot: ArtifactSnapshot): ArtifactSnapshot {
	return {
		...snapshot,
		localPath: undefined,
		metadataFile: snapshot.metadataFile
			? {
					...snapshot.metadataFile,
					name: snapshot.metadataFile.name.split(/[\\/]/).at(-1) ?? snapshot.metadataFile.name,
				}
			: undefined,
		licenseFiles: snapshot.licenseFiles?.map((name) => name.split(/[\\/]/).at(-1) ?? name),
	};
}

export function stableFingerprint(value: unknown): string {
	const normalize = (entry: unknown): unknown =>
		Array.isArray(entry)
			? entry.map(normalize)
			: entry && typeof entry === "object"
				? Object.fromEntries(
						Object.entries(entry as Record<string, unknown>)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, child]) => [key, normalize(child)]),
					)
				: entry;
	return createHash("sha256")
		.update(JSON.stringify(normalize(value)))
		.digest("hex");
}

export function sanitizeArtifactManifestForTeam(manifest: ArtifactManifest): ArtifactManifest {
	return {
		...manifest,
		pdfPath: manifest.pdfPath.split(/[\\/]/).at(-1) ?? "paper.pdf",
		candidates: manifest.candidates.map((candidate) => ({
			...candidate,
			sources: candidate.sources.map((source) => ({ ...source, context: source.context?.slice(0, 2_000) })),
		})),
		acquisitions: manifest.acquisitions.map(sanitizeSnapshot),
	};
}
