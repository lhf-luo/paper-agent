import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PdfMaterialRecord, SavePdfMaterialInput } from "../../pdf/domain/pdf-material-types.ts";
import { PersonalArtifactRepository } from "./personal-artifact-repository.ts";

interface PdfMaterialRow {
	id: string;
	paper_id: string;
	paper_version_id: string;
	source_sha256: string;
	relative_path: string;
	engine: "mineru";
	model_version: "pipeline" | "vlm";
	package_sha256: string;
	content_sha256: string;
	page_count: number;
	file_count: number;
	bytes: number;
	created_at: string;
	updated_at: string;
}

export abstract class PersonalPdfMaterialRepository extends PersonalArtifactRepository {
	private hydratePdfMaterial(row: PdfMaterialRow): PdfMaterialRecord {
		return {
			id: row.id,
			namespace: this.namespace,
			paperId: row.paper_id,
			paperVersionId: row.paper_version_id,
			sourceSha256: row.source_sha256,
			relativePath: row.relative_path,
			path: resolve(this.dataRoot, row.relative_path),
			engine: row.engine,
			modelVersion: row.model_version,
			packageSha256: row.package_sha256,
			contentSha256: row.content_sha256,
			pageCount: row.page_count,
			fileCount: row.file_count,
			bytes: row.bytes,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	async getPdfMaterial(paperId: string): Promise<PdfMaterialRecord | undefined> {
		await this.initialize();
		return this.read((database) => {
			const row = database
				.prepare(`SELECT m.*, p.paper_id FROM pdf_materials m
					JOIN papers p ON p.row_id = m.paper_row_id
					WHERE m.namespace_id = ? AND p.paper_id = ?`)
				.get(this.namespace, paperId) as PdfMaterialRow | undefined;
			return row ? this.hydratePdfMaterial(row) : undefined;
		});
	}

	async savePdfMaterial(input: SavePdfMaterialInput): Promise<PdfMaterialRecord> {
		await this.initialize();
		const now = new Date().toISOString();
		this.write((database) => {
			const paper = this.paperRow(database, input.paperId);
			if (!paper) throw new Error(`Paper not found in personal corpus: ${input.paperId}`);
			const version = database
				.prepare(`SELECT pv.id FROM paper_versions pv
					JOIN stored_files sf ON sf.id = pv.file_id
					WHERE pv.paper_row_id = ? AND lower(sf.sha256) = lower(?)`)
				.get(paper.row_id, input.sourceSha256) as { id: string } | undefined;
			if (!version) throw new Error("The source PDF version no longer exists");
			database
				.prepare(`INSERT INTO pdf_materials(
					id, namespace_id, paper_row_id, paper_version_id, source_sha256, relative_path,
					engine, model_version, package_sha256, content_sha256, page_count, file_count,
					bytes, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(paper_row_id) DO UPDATE SET
					paper_version_id=excluded.paper_version_id, source_sha256=excluded.source_sha256,
					relative_path=excluded.relative_path, engine=excluded.engine,
					model_version=excluded.model_version, package_sha256=excluded.package_sha256,
					content_sha256=excluded.content_sha256, page_count=excluded.page_count,
					file_count=excluded.file_count, bytes=excluded.bytes, updated_at=excluded.updated_at`)
				.run(
					`material-${randomUUID()}`,
					this.namespace,
					paper.row_id,
					version.id,
					input.sourceSha256,
					input.relativePath,
					input.engine,
					input.modelVersion,
					input.packageSha256,
					input.contentSha256,
					input.pageCount,
					input.fileCount,
					input.bytes,
					now,
					now,
				);
		});
		const saved = await this.getPdfMaterial(input.paperId);
		if (!saved) throw new Error("MinerU material was written but could not be read back");
		return saved;
	}

	async deletePdfMaterial(paperId: string): Promise<PdfMaterialRecord | undefined> {
		const existing = await this.getPdfMaterial(paperId);
		if (!existing) return undefined;
		this.write((database) => {
			const paper = this.paperRow(database, paperId);
			if (paper) database.prepare("DELETE FROM pdf_materials WHERE paper_row_id = ?").run(paper.row_id);
		});
		return existing;
	}
}
