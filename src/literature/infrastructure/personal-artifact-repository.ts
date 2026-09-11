import type { ArtifactManifest } from "../domain/literature-types.ts";
import { json, parseJson } from "./personal-database-support.ts";
import { PersonalDerivedRepository } from "./personal-derived-repository.ts";

export abstract class PersonalArtifactRepository extends PersonalDerivedRepository {
	async saveArtifactManifest(manifest: ArtifactManifest, paperId?: string): Promise<string> {
		await this.initialize();
		const id = `artifact-${manifest.pdfSha256.slice(0, 24)}`;
		const now = new Date().toISOString();
		this.write((database) => {
			if (paperId && !this.paperRow(database, paperId)) {
				throw new Error(`Paper not found in personal corpus: ${paperId}`);
			}
			database
				.prepare(`
					INSERT INTO artifact_manifests(
						id, namespace_id, paper_id, pdf_sha256, manifest_json, discovered_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(namespace_id, id) DO UPDATE SET
						paper_id = excluded.paper_id,
						pdf_sha256 = excluded.pdf_sha256,
						manifest_json = excluded.manifest_json,
						discovered_at = excluded.discovered_at,
						updated_at = excluded.updated_at
				`)
				.run(id, this.namespace, paperId ?? null, manifest.pdfSha256, json(manifest), manifest.discoveredAt, now);
		});
		return id;
	}

	async listArtifactManifests(paperId?: string): Promise<ArtifactManifest[]> {
		await this.initialize();
		return this.read((database) => {
			const rows = (paperId
				? database
						.prepare(
							"SELECT manifest_json FROM artifact_manifests WHERE namespace_id = ? AND paper_id = ? ORDER BY updated_at DESC",
						)
						.all(this.namespace, paperId)
				: database
						.prepare(
							"SELECT manifest_json FROM artifact_manifests WHERE namespace_id = ? ORDER BY updated_at DESC",
						)
						.all(this.namespace)) as unknown as Array<{ manifest_json: string }>;
			return rows.map((row) => parseJson<ArtifactManifest>(row.manifest_json));
		});
	}
}
