import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { LiteratureStore } from "./literature-store.ts";
import type { TeamTokenRegistryBackupSnapshot } from "./team-token-registry.ts";

export interface TeamBackupFile {
	path: string;
	bytes: number;
	sha256: string;
}

export interface TeamBackupManifest {
	schemaVersion: 1;
	serviceVersion: 2;
	namespace: string;
	createdAt: string;
	includes: {
		namespace: true;
		tokenRegistry: true;
		tokenAudit: true;
	};
	files: TeamBackupFile[];
}

function inside(base: string, target: string): boolean {
	const path = relative(resolve(base), resolve(target));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function safeRelativePath(root: string, path: string): string {
	const value = relative(root, path).replaceAll("\\", "/");
	if (!value || value.startsWith("../") || value.includes("/../") || isAbsolute(value)) {
		throw new Error("Backup entry resolves outside its bundle");
	}
	return value;
}

async function inventory(root: string): Promise<TeamBackupFile[]> {
	const files: TeamBackupFile[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Team backups do not permit symbolic links");
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isFile()) throw new Error(`Unsupported backup entry: ${entry.name}`);
			const body = await readFile(path);
			files.push({
				path: safeRelativePath(root, path),
				bytes: body.byteLength,
				sha256: createHash("sha256").update(body).digest("hex"),
			});
		}
	};
	await visit(root);
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function validateManifest(value: unknown): TeamBackupManifest {
	if (!value || typeof value !== "object") throw new Error("Team backup manifest is invalid");
	const manifest = value as TeamBackupManifest;
	if (
		manifest.schemaVersion !== 1 ||
		manifest.serviceVersion !== 2 ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.namespace) ||
		!Number.isFinite(Date.parse(manifest.createdAt)) ||
		manifest.includes?.namespace !== true ||
		manifest.includes?.tokenRegistry !== true ||
		manifest.includes?.tokenAudit !== true ||
		!Array.isArray(manifest.files)
	) {
		throw new Error("Team backup manifest is invalid");
	}
	for (const file of manifest.files) {
		if (
			!file ||
			typeof file.path !== "string" ||
			file.path === "backup-manifest.json" ||
			file.path.startsWith("/") ||
			file.path.includes("..") ||
			!Number.isInteger(file.bytes) ||
			file.bytes < 0 ||
			!/^[a-f0-9]{64}$/.test(file.sha256)
		) {
			throw new Error("Team backup file inventory is invalid");
		}
	}
	return manifest;
}

export async function createTeamBackupBundle(input: {
	namespaceRoot: string;
	namespace: string;
	destinationRoot: string;
	security: TeamTokenRegistryBackupSnapshot;
}): Promise<{ backupPath: string; manifest: TeamBackupManifest }> {
	const namespaceRoot = resolve(input.namespaceRoot);
	const destinationRoot = resolve(input.destinationRoot);
	if (inside(namespaceRoot, destinationRoot)) throw new Error("Backup destination must not be inside the namespace root");
	const timestamp = new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 14);
	const name = `team-${input.namespace}-${timestamp}-${randomUUID().slice(0, 8)}`;
	const temporaryPath = join(destinationRoot, `${name}.tmp`);
	const backupPath = join(destinationRoot, name);
	await mkdir(destinationRoot, { recursive: true });
	try {
		await mkdir(join(temporaryPath, "_security"), { recursive: true });
		await cp(namespaceRoot, join(temporaryPath, "namespace"), {
			recursive: true,
			filter: (source) => source !== join(namespaceRoot, ".write.lock"),
		});
		await writeFile(
			join(temporaryPath, "_security", "identities.json"),
			`${JSON.stringify(input.security.registry, null, 2)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await writeFile(join(temporaryPath, "_security", "token-audit.jsonl"), input.security.auditJsonl, "utf8");
		const manifest: TeamBackupManifest = {
			schemaVersion: 1,
			serviceVersion: 2,
			namespace: input.namespace,
			createdAt: new Date().toISOString(),
			includes: { namespace: true, tokenRegistry: true, tokenAudit: true },
			files: await inventory(temporaryPath),
		};
		await writeFile(join(temporaryPath, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await rename(temporaryPath, backupPath);
		return { backupPath, manifest };
	} catch (error) {
		await rm(temporaryPath, { recursive: true, force: true });
		throw error;
	}
}

export async function validateTeamBackupBundle(backupPath: string): Promise<TeamBackupManifest> {
	const root = resolve(backupPath);
	const manifest = validateManifest(JSON.parse(await readFile(join(root, "backup-manifest.json"), "utf8")));
	const actual = await inventory(root);
	const withoutManifest = actual.filter((file) => file.path !== "backup-manifest.json");
	if (JSON.stringify(withoutManifest) !== JSON.stringify(manifest.files)) {
		throw new Error("Team backup contents do not match the SHA-256 file inventory");
	}
	const registry = JSON.parse(await readFile(join(root, "_security", "identities.json"), "utf8")) as {
		schemaVersion?: number;
		identities?: Array<{ tokenSha256?: string }>;
	};
	if (
		registry.schemaVersion !== 1 ||
		!Array.isArray(registry.identities) ||
		!registry.identities.every((identity) => /^[a-f0-9]{64}$/i.test(identity.tokenSha256 ?? ""))
	) {
		throw new Error("Team backup token registry is invalid");
	}
	return manifest;
}

export async function runTeamBackupRestoreDrill(
	backupPath: string,
	drillRoot: string,
): Promise<{
	validated: true;
	namespace: string;
	identityCount: number;
	stats: {
		recordCount: number;
		derivedCount: number;
		artifactCount: number;
		blobCount: number;
		blobBytes: number;
	};
}> {
	const manifest = await validateTeamBackupBundle(backupPath);
	await mkdir(drillRoot, { recursive: true });
	const temporary = await mkdtemp(join(resolve(drillRoot), "team-restore-drill-"));
	try {
		const restoredRoot = join(temporary, manifest.namespace);
		await cp(join(resolve(backupPath), "namespace"), restoredRoot, { recursive: true });
		const store = new LiteratureStore(restoredRoot, "team", manifest.namespace);
		const audit = await store.audit();
		const registry = JSON.parse(
			await readFile(join(resolve(backupPath), "_security", "identities.json"), "utf8"),
		) as { identities: unknown[] };
		return {
			validated: true,
			namespace: manifest.namespace,
			identityCount: registry.identities.length,
			stats: {
				recordCount: audit.manifest.recordCount,
				derivedCount: manifest.files.filter((file) => /^namespace\/knowledge\/derived\/[^/]+\.json$/.test(file.path))
					.length,
				artifactCount: manifest.files.filter((file) => /^namespace\/knowledge\/artifacts\/[^/]+\.json$/.test(file.path))
					.length,
				blobCount: manifest.files.filter((file) => /^namespace\/blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(file.path))
					.length,
				blobBytes: manifest.files
					.filter((file) => /^namespace\/blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(file.path))
					.reduce((total, file) => total + file.bytes, 0),
			},
		};
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
