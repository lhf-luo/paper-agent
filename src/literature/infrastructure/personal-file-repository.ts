import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PaperVersion } from "../domain/literature-types.ts";
import {
	inferredVersionKind,
	json,
	type PaperRow,
	type PersonalBlob,
	type PreparedFile,
	parseJson,
	pathExists,
	readablePdfTitle,
	type StoredVersionRow,
	safePathSegment,
	versionSuffix,
} from "./personal-database-support.ts";
import { PersonalPdfMaterialRepository } from "./personal-pdf-material-repository.ts";

export abstract class PersonalFileRepository extends PersonalPdfMaterialRepository {
	protected versionRows(database: DatabaseSync, paperId: string): StoredVersionRow[] {
		const paper = this.paperRow(database, paperId);
		if (!paper) return [];
		return database
			.prepare(`SELECT
				pv.id AS version_id, pv.publication_version_id, pv.file_id, pv.version_json,
				sf.relative_path, sf.filename, sf.sha256, sf.bytes, sf.content_type
			FROM paper_versions pv
			JOIN stored_files sf ON sf.id = pv.file_id
			WHERE pv.paper_row_id = ?
			ORDER BY pv.retrieved_at DESC, pv.id DESC`)
			.all(paper.row_id) as unknown as StoredVersionRow[];
	}

	protected hydrateVersion(row: StoredVersionRow): PaperVersion {
		return {
			...parseJson<PaperVersion>(row.version_json),
			publicationVersionId: row.publication_version_id ?? undefined,
			sha256: row.sha256,
			bytes: row.bytes,
			contentType: row.content_type,
			blobPath: resolve(this.dataRoot, row.relative_path),
		};
	}

	async putBlob(data: Uint8Array): Promise<PersonalBlob> {
		await this.initialize();
		const sha256 = createHash("sha256").update(data).digest("hex");
		const existing = this.read(
			(database) =>
				database
					.prepare("SELECT relative_path FROM stored_files WHERE namespace_id = ? AND sha256 = ? LIMIT 1")
					.get(this.namespace, sha256) as { relative_path: string } | undefined,
		);
		if (existing) {
			const path = resolve(this.dataRoot, existing.relative_path);
			if (await pathExists(path)) return { sha256, path, existed: true };
		}
		const stagingRoot = join(this.filesRoot, ".staging");
		await mkdir(stagingRoot, { recursive: true });
		const path = join(stagingRoot, `${randomUUID()}.pdf`);
		await writeFile(path, data, { flag: "wx" });
		return { sha256, path, existed: false };
	}

	protected async allocateVersionFile(
		database: DatabaseSync,
		paper: PaperRow,
		version: PaperVersion,
		sourcePath: string,
	): Promise<PreparedFile> {
		const source = resolve(sourcePath);
		const body = await readFile(source);
		const sha256 = createHash("sha256").update(body).digest("hex");
		if (sha256 !== version.sha256.toLowerCase()) {
			throw new Error(`PDF checksum mismatch for ${version.paperId}`);
		}
		const duplicate = database
			.prepare(`SELECT pv.id FROM paper_versions pv
				JOIN papers p ON p.row_id = pv.paper_row_id
				JOIN stored_files sf ON sf.id = pv.file_id
				WHERE p.row_id = ? AND sf.sha256 = ? LIMIT 1`)
			.get(paper.row_id, sha256) as { id: string } | undefined;
		if (duplicate) {
			if (source.startsWith(resolve(join(this.filesRoot, ".staging")))) await unlink(source).catch(() => {});
			throw Object.assign(new Error("PDF version already exists"), { code: "PAPER_VERSION_EXISTS" });
		}

		const kind = inferredVersionKind(version);
		const sameKindCount = database
			.prepare(
				"SELECT COUNT(*) AS count FROM paper_versions WHERE paper_row_id = ? AND COALESCE(version_kind, 'unknown') = ?",
			)
			.get(paper.row_id, kind) as { count: number };
		const ordinal = Number(sameKindCount.count) + 1;
		const directory = join(this.filesRoot, safePathSegment(paper.paper_id, "paper"));
		await mkdir(directory, { recursive: true });
		const versionId = `version-${randomUUID()}`;
		const suffix = versionSuffix(kind, ordinal, version.versionLabel);
		const title = readablePdfTitle(directory, paper.title, safePathSegment(paper.paper_id, "paper"), suffix);
		let filename = `${title}${suffix}.pdf`;
		let absolutePath = join(directory, filename);
		if (await pathExists(absolutePath)) {
			const collisionSuffix = `${suffix} [${versionId.slice(-8)}]`;
			const collisionTitle = readablePdfTitle(
				directory,
				paper.title,
				safePathSegment(paper.paper_id, "paper"),
				collisionSuffix,
			);
			filename = `${collisionTitle}${collisionSuffix}.pdf`;
			absolutePath = join(directory, filename);
		}
		const relativePath = relative(this.dataRoot, absolutePath);
		return {
			fileId: `file-${randomUUID()}`,
			versionId,
			paperId: paper.paper_id,
			sha256,
			bytes: body.byteLength,
			contentType: version.contentType || "application/pdf",
			filename,
			relativePath,
			absolutePath,
			originalFilename: basename(source),
			version: {
				...version,
				paperId: paper.paper_id,
				versionKind: kind,
				blobPath: absolutePath,
				bytes: body.byteLength,
				sha256,
			},
		};
	}

	protected async materializeFile(sourcePath: string, targetPath: string): Promise<void> {
		const source = resolve(sourcePath);
		const stagingRoot = resolve(join(this.filesRoot, ".staging"));
		if (source.startsWith(stagingRoot)) {
			await rename(source, targetPath);
			return;
		}
		try {
			await link(source, targetPath);
		} catch {
			await copyFile(source, targetPath);
		}
	}

	protected insertPreparedFile(database: DatabaseSync, paperRowId: number, file: PreparedFile): void {
		const now = new Date().toISOString();
		const relatedVersionId = file.version.relatedVersionSha256
			? ((
					database
						.prepare(
							`SELECT paper_versions.id
							 FROM paper_versions
							 JOIN stored_files ON stored_files.id = paper_versions.file_id
							 WHERE paper_versions.paper_row_id = ? AND lower(stored_files.sha256) = lower(?)`,
						)
						.get(paperRowId, file.version.relatedVersionSha256) as { id: string } | undefined
				)?.id ?? null)
			: null;
		if (file.version.publicationVersionId) {
			const linked = database
				.prepare("SELECT 1 FROM publication_versions WHERE id = ? AND paper_row_id = ?")
				.get(file.version.publicationVersionId, paperRowId);
			if (!linked) throw new Error("Publication version does not belong to this paper");
		}
		database
			.prepare(
				"INSERT INTO stored_files(id, namespace_id, relative_path, filename, original_filename, sha256, bytes, content_type, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				file.fileId,
				this.namespace,
				file.relativePath,
				file.filename,
				file.originalFilename,
				file.sha256,
				file.bytes,
				file.contentType,
				now,
				now,
			);
		database
			.prepare(`INSERT INTO paper_versions(
				id, paper_row_id, publication_version_id, file_id, source_url, final_url, retrieved_at, version_kind,
				version_label, related_version_id, is_preferred, version_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				file.versionId,
				paperRowId,
				file.version.publicationVersionId ?? null,
				file.fileId,
				file.version.sourceUrl,
				file.version.finalUrl,
				file.version.retrievedAt,
				file.version.versionKind ?? null,
				file.version.versionLabel ?? null,
				relatedVersionId,
				Number(file.version.isPreferred ?? false),
				json(file.version),
			);
	}

	async savePaperVersion(version: PaperVersion): Promise<void> {
		await this.initialize();
		const requestedVersion = version;
		const database = this.open();
		let prepared: PreparedFile | undefined;
		try {
			database.exec("BEGIN IMMEDIATE");
			const paper = this.paperRow(database, version.paperId);
			if (!paper) throw new Error(`Paper not found in corpus: ${version.paperId}`);
			if (!version.publicationVersionId && ["published", "preprint"].includes(inferredVersionKind(version))) {
				const kind = inferredVersionKind(version);
				const publicationVersion = this.syncPublicationVersions(
					database,
					paper.row_id,
					parseJson(paper.record_json),
					kind === "published",
				).find((candidate) => candidate.kind === kind);
				if (publicationVersion) {
					version = {
						...version,
						publicationVersionId: publicationVersion.id,
						isPreferred: version.isPreferred ?? publicationVersion.isPreferred,
					};
				}
			}
			try {
				prepared = await this.allocateVersionFile(database, paper, version, version.blobPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "PAPER_VERSION_EXISTS") {
					database.exec("ROLLBACK");
					return;
				}
				throw error;
			}
			await this.materializeFile(version.blobPath, prepared.absolutePath);
			this.insertPreparedFile(database, paper.row_id, prepared);
			database.exec("COMMIT");
			Object.assign(requestedVersion, prepared.version, {
				blobPath: prepared.absolutePath,
				bytes: prepared.bytes,
				sha256: prepared.sha256,
			});
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the primary error.
			}
			if (prepared) await unlink(prepared.absolutePath).catch(() => {});
			throw error;
		} finally {
			database.close();
		}
	}

	async listPaperVersions(paperId: string): Promise<PaperVersion[]> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "paper-versions", `${paperId}.json`)))
		)
			return [];
		await this.initialize();
		return this.read((database) => this.versionRows(database, paperId).map((row) => this.hydrateVersion(row)));
	}

	async readPaperVersionBlob(paperId: string, sha256: string): Promise<Buffer> {
		const version = (await this.listPaperVersions(paperId)).find((item) => item.sha256 === sha256);
		if (!version) throw new Error("PDF version was not found in the selected corpus");
		const root = resolve(this.filesRoot);
		const path = resolve(version.blobPath);
		const relativePath = relative(root, path);
		if (relativePath.startsWith("..") || resolve(root, relativePath) !== path) {
			throw new Error("PDF file resolves outside the selected namespace");
		}
		const body = await readFile(path);
		const actual = createHash("sha256").update(body).digest("hex");
		if (actual !== sha256.toLowerCase()) throw new Error("PDF checksum verification failed");
		return body;
	}

	protected async renamePaperFiles(paperId: string, title: string): Promise<string[]> {
		const warnings: string[] = [];
		const database = this.open();
		try {
			const paper = this.paperRow(database, paperId);
			if (!paper) return warnings;
			const rows = this.versionRows(database, paperId).reverse();
			const kindOrdinals = new Map<string, number>();
			for (const row of rows) {
				const version = this.hydrateVersion(row);
				const kind = inferredVersionKind(version);
				const ordinal = (kindOrdinals.get(kind) ?? 0) + 1;
				kindOrdinals.set(kind, ordinal);
				const directory = dirname(version.blobPath);
				const suffix = versionSuffix(kind, ordinal, version.versionLabel);
				const safeTitle = readablePdfTitle(directory, title, safePathSegment(paperId, "paper"), suffix);
				let filename = `${safeTitle}${suffix}.pdf`;
				let target = join(directory, filename);
				if (target === version.blobPath) continue;
				if (await pathExists(target)) {
					const collisionSuffix = `${suffix} [${row.version_id.slice(-8)}]`;
					const collisionTitle = readablePdfTitle(
						directory,
						title,
						safePathSegment(paperId, "paper"),
						collisionSuffix,
					);
					filename = `${collisionTitle}${collisionSuffix}.pdf`;
					target = join(directory, filename);
				}
				const operationId = `file-op-${randomUUID()}`;
				const now = new Date().toISOString();
				database
					.prepare(
						"INSERT INTO file_operations(id, operation, paper_row_id, file_id, from_path, to_path, status, created_at) VALUES (?, 'rename', ?, ?, ?, ?, 'pending', ?)",
					)
					.run(operationId, paper.row_id, row.file_id, version.blobPath, target, now);
				const temporary = join(directory, `.${row.file_id}.rename.tmp`);
				try {
					await rename(version.blobPath, temporary);
					await rename(temporary, target);
					const updatedVersion = { ...version, blobPath: target };
					database.exec("BEGIN IMMEDIATE");
					database
						.prepare("UPDATE stored_files SET relative_path = ?, filename = ? WHERE id = ?")
						.run(relative(this.dataRoot, target), filename, row.file_id);
					database
						.prepare("UPDATE paper_versions SET version_json = ? WHERE id = ?")
						.run(json(updatedVersion), row.version_id);
					database
						.prepare("UPDATE file_operations SET status = 'completed', completed_at = ? WHERE id = ?")
						.run(new Date().toISOString(), operationId);
					database.exec("COMMIT");
				} catch (error) {
					try {
						database.exec("ROLLBACK");
					} catch {
						// No active transaction is also valid here.
					}
					if (await pathExists(temporary)) await rename(temporary, version.blobPath).catch(() => {});
					const message = error instanceof Error ? error.message : String(error);
					database
						.prepare("UPDATE file_operations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
						.run(message, new Date().toISOString(), operationId);
					warnings.push(`${row.filename}: ${message}`);
				}
			}
		} finally {
			database.close();
		}
		return warnings;
	}

	protected async recoverFileOperations(): Promise<void> {
		const pending = this.read(
			(database) =>
				database
					.prepare("SELECT id, file_id, from_path, to_path FROM file_operations WHERE status = 'pending'")
					.all() as unknown as Array<{
					id: string;
					file_id: string | null;
					from_path: string | null;
					to_path: string;
				}>,
		);
		for (const operation of pending) {
			const targetExists = await pathExists(operation.to_path);
			const sourceExists = operation.from_path ? await pathExists(operation.from_path) : false;
			this.write((database) => {
				if (targetExists && operation.file_id) {
					database
						.prepare("UPDATE stored_files SET relative_path = ?, filename = ? WHERE id = ?")
						.run(relative(this.dataRoot, operation.to_path), basename(operation.to_path), operation.file_id);
				}
				database
					.prepare("UPDATE file_operations SET status = ?, error = ?, completed_at = ? WHERE id = ?")
					.run(
						targetExists ? "completed" : "failed",
						targetExists
							? null
							: sourceExists
								? "Rename was interrupted before completion"
								: "Source and target are missing",
						new Date().toISOString(),
						operation.id,
					);
			});
		}
	}
}
