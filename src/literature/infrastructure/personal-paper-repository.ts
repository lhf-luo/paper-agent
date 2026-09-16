import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	normalizeArxivId,
	normalizeDoi,
	normalizeTitle,
	withCanonicalPaperLinks,
} from "../domain/literature-identifiers.ts";
import type { PaperPublicationVersion, PaperRecord } from "../domain/literature-types.ts";

import { json, normalizeAuthor, parseJson, pathExists } from "./personal-database-support.ts";
import { PersonalPaperHydrationRepository } from "./personal-paper-hydration-repository.ts";

export abstract class PersonalPaperRepository extends PersonalPaperHydrationRepository {
	private publicationVersionId(paperId: string, kind: PaperPublicationVersion["kind"]): string {
		return `publication-${createHash("sha256").update(`${paperId}:${kind}`).digest("hex").slice(0, 24)}`;
	}

	protected syncPublicationVersions(
		database: DatabaseSync,
		paperRowId: number,
		record: PaperRecord,
		forcePublished = false,
	): PaperPublicationVersion[] {
		const now = new Date().toISOString();
		const doi = normalizeDoi(record.identifiers.doi);
		const arxivId = normalizeArxivId(record.identifiers.arxivId);
		const existing = database
			.prepare("SELECT kind, created_at FROM publication_versions WHERE paper_row_id = ?")
			.all(paperRowId) as unknown as Array<{ kind: PaperPublicationVersion["kind"]; created_at: string }>;
		const createdAt = new Map(existing.map((row) => [row.kind, row.created_at]));
		const kinds: PaperPublicationVersion["kind"][] = [];
		if (doi || forcePublished || existing.some((row) => row.kind === "published")) kinds.push("published");
		if (arxivId) kinds.push("preprint");
		if (!kinds.length) kinds.push("unknown");
		const preferredKind = kinds.includes("published") ? "published" : kinds[0];
		const versions = kinds.map((kind): PaperPublicationVersion => {
			const isPreprint = kind === "preprint";
			return {
				id: this.publicationVersionId(record.id, kind),
				paperId: record.id,
				kind,
				title: record.title,
				authors: record.authors,
				year: record.year,
				venue: record.venue,
				identifiers: isPreprint ? { arxivId } : { ...record.identifiers, arxivId: undefined },
				links: record.links.filter((link) => /arxiv\.org/i.test(link.url) === isPreprint),
				isPreferred: kind === preferredKind,
				createdAt: createdAt.get(kind) ?? now,
				updatedAt: now,
			};
		});
		database.prepare("UPDATE publication_versions SET is_preferred = 0 WHERE paper_row_id = ?").run(paperRowId);
		const upsert = database.prepare(`INSERT INTO publication_versions(
			id, paper_row_id, kind, doi, arxiv_id, is_preferred, record_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(paper_row_id, kind) DO UPDATE SET
			doi=excluded.doi, arxiv_id=excluded.arxiv_id, is_preferred=excluded.is_preferred,
			record_json=excluded.record_json, updated_at=excluded.updated_at`);
		for (const version of versions) {
			upsert.run(
				version.id,
				paperRowId,
				version.kind,
				version.identifiers.doi ?? null,
				version.identifiers.arxivId ?? null,
				Number(version.isPreferred),
				json(version),
				version.createdAt,
				version.updatedAt,
			);
		}
		if (!kinds.includes("unknown")) {
			database
				.prepare("DELETE FROM publication_versions WHERE paper_row_id = ? AND kind = 'unknown'")
				.run(paperRowId);
		}
		return versions;
	}

	async listPublicationVersions(paperId: string): Promise<PaperPublicationVersion[]> {
		await this.initialize();
		return this.read((database) => {
			const paper = this.paperRow(database, paperId);
			if (!paper) return [];
			return (
				database
					.prepare(
						"SELECT record_json, is_preferred FROM publication_versions WHERE paper_row_id = ? ORDER BY is_preferred DESC, created_at",
					)
					.all(paper.row_id) as unknown as Array<{ record_json: string; is_preferred: number }>
			).map((row) => ({
				...parseJson<PaperPublicationVersion>(row.record_json),
				paperId: paper.paper_id,
				isPreferred: Boolean(row.is_preferred),
			}));
		});
	}

	async ensurePublicationVersions(paperId: string, forcePublished = false): Promise<PaperPublicationVersion[]> {
		await this.initialize();
		return this.write((database) => {
			const paper = this.paperRow(database, paperId);
			if (!paper) throw new Error(`Paper not found in corpus: ${paperId}`);
			return this.syncPublicationVersions(
				database,
				paper.row_id,
				parseJson<PaperRecord>(paper.record_json),
				forcePublished,
			);
		});
	}

	protected syncPaper(database: DatabaseSync, record: PaperRecord, previousId?: string): number {
		record = withCanonicalPaperLinks(record);
		const now = new Date().toISOString();
		const previous = previousId ? this.paperRow(database, previousId) : undefined;
		if (previous && previous.paper_id !== record.id) {
			record = {
				...record,
				id: previous.paper_id,
				mergedFrom: [
					...new Set(
						[...record.mergedFrom, record.id, previousId].filter(
							(id): id is string => Boolean(id) && id !== previous.paper_id,
						),
					),
				],
			};
		}
		database
			.prepare(`
				INSERT INTO papers(
					namespace_id, paper_id, title, normalized_title, abstract, year, venue, venue_rank,
					publication_type, citation_count, cited_by_api_url, doi, arxiv_id, openalex_id,
					semantic_scholar_id, dblp_key, core_id, opencitations_id, record_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(namespace_id, paper_id) DO UPDATE SET
					title=excluded.title, normalized_title=excluded.normalized_title, abstract=excluded.abstract,
					year=excluded.year, venue=excluded.venue, venue_rank=excluded.venue_rank,
					publication_type=excluded.publication_type, citation_count=excluded.citation_count,
					cited_by_api_url=excluded.cited_by_api_url, doi=excluded.doi, arxiv_id=excluded.arxiv_id,
					openalex_id=excluded.openalex_id, semantic_scholar_id=excluded.semantic_scholar_id,
					dblp_key=excluded.dblp_key, core_id=excluded.core_id, opencitations_id=excluded.opencitations_id,
					record_json=excluded.record_json, updated_at=excluded.updated_at
			`)
			.run(
				this.namespace,
				record.id,
				record.title,
				normalizeTitle(record.title),
				record.abstract ?? null,
				record.year ?? null,
				record.venue ?? null,
				record.venueRank ?? null,
				record.publicationType ?? null,
				record.citationCount ?? null,
				record.citedByApiUrl ?? null,
				record.identifiers.doi ?? null,
				record.identifiers.arxivId ?? null,
				record.identifiers.openAlexId ?? null,
				record.identifiers.semanticScholarId ?? null,
				record.identifiers.dblpKey ?? null,
				record.identifiers.coreId ?? null,
				record.identifiers.openCitationsId ?? null,
				json(record),
				now,
				now,
			);
		const row = this.paperRow(database, record.id);
		if (!row) throw new Error(`Paper write failed: ${record.id}`);
		const paperRowId = row.row_id;
		for (const table of [
			"paper_authors",
			"paper_links",
			"paper_provenance",
			"paper_discovery_paths",
			"paper_references",
			"paper_merges",
			"paper_collections",
			"paper_tags",
			"paper_notes",
			"paper_curation",
		]) {
			database
				.prepare(
					`DELETE FROM ${table} WHERE ${table === "paper_merges" ? "canonical_paper_row_id" : "paper_row_id"} = ?`,
				)
				.run(paperRowId);
		}
		const authorInsert = database.prepare(
			"INSERT INTO paper_authors(paper_row_id, position, name, normalized_name) VALUES (?, ?, ?, ?)",
		);
		for (const [position, author] of record.authors.entries())
			authorInsert.run(paperRowId, position, author, normalizeAuthor(author));
		const linkInsert = database.prepare(`
			INSERT INTO paper_links(paper_row_id, url, kind, open_access, created_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(paper_row_id, url) DO UPDATE SET
				kind = excluded.kind,
				open_access = COALESCE(excluded.open_access, paper_links.open_access)
		`);
		for (const item of record.links)
			linkInsert.run(
				paperRowId,
				item.url,
				item.kind,
				item.openAccess === undefined ? null : Number(item.openAccess),
				now,
			);
		const provenanceInsert = database.prepare(
			"INSERT INTO paper_provenance(paper_row_id, provider, query, retrieved_at, provider_record_id, raw_url) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const item of record.provenance)
			provenanceInsert.run(
				paperRowId,
				item.provider,
				item.query,
				item.retrievedAt,
				item.providerRecordId ?? null,
				item.rawUrl ?? null,
			);
		const discoveryInsert = database.prepare(
			"INSERT INTO paper_discovery_paths(paper_row_id, kind, query, provider, seed_paper_id, source_url, note, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const item of record.discoveryPaths ?? [])
			discoveryInsert.run(
				paperRowId,
				item.kind,
				item.query ?? null,
				item.provider ?? null,
				item.seedPaperId ?? null,
				item.sourceUrl ?? null,
				item.note ?? null,
				item.discoveredAt,
			);
		const referenceInsert = database.prepare(
			"INSERT INTO paper_references(paper_row_id, position, referenced_work_id) VALUES (?, ?, ?)",
		);
		for (const [position, id] of (record.referencedWorks ?? []).entries())
			referenceInsert.run(paperRowId, position, id);
		const mergeInsert = database.prepare(
			"INSERT OR IGNORE INTO paper_merges(canonical_paper_row_id, merged_from_id, reason, merged_at) VALUES (?, ?, ?, ?)",
		);
		for (const id of record.mergedFrom) mergeInsert.run(paperRowId, id, "exact-identity", now);
		const collectionInsert = database.prepare(
			"INSERT OR IGNORE INTO paper_collections(paper_row_id, collection_id, added_at) SELECT ?, id, ? FROM collections WHERE namespace_id = ? AND id = ?",
		);
		for (const id of record.collectionIds ?? []) collectionInsert.run(paperRowId, now, this.namespace, id);
		const tagInsert = database.prepare(
			"INSERT OR IGNORE INTO paper_tags(paper_row_id, tag, normalized_tag) VALUES (?, ?, ?)",
		);
		for (const tag of record.curation?.tags ?? []) tagInsert.run(paperRowId, tag, tag.trim().toLowerCase());
		const noteInsert = database.prepare(
			"INSERT INTO paper_notes(id, paper_row_id, text, author, created_at) VALUES (?, ?, ?, ?, ?)",
		);
		for (const note of record.curation?.userNotes ?? [])
			noteInsert.run(`${this.namespace}:${note.id}`, paperRowId, note.text, note.author, note.createdAt);
		if (record.curation) {
			const value = record.curation;
			database
				.prepare(`INSERT INTO paper_curation(
				paper_row_id, screening_status, screening_reason, screening_updated_by, screening_updated_at,
				reading_status, reading_note, reading_updated_by, reading_updated_at, team_review_status,
				proposed_by, proposed_at, reviewed_by, reviewed_at, review_reason
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					paperRowId,
					value.screening?.status ?? null,
					value.screening?.reason ?? null,
					value.screening?.updatedBy ?? null,
					value.screening?.updatedAt ?? null,
					value.reading?.status ?? null,
					value.reading?.note ?? null,
					value.reading?.updatedBy ?? null,
					value.reading?.updatedAt ?? null,
					value.teamReview?.status ?? null,
					value.teamReview?.proposedBy ?? null,
					value.teamReview?.proposedAt ?? null,
					value.teamReview?.reviewedBy ?? null,
					value.teamReview?.reviewedAt ?? null,
					value.teamReview?.reason ?? null,
				);
		}
		database.prepare("DELETE FROM paper_search WHERE paper_row_id = ?").run(paperRowId);
		database
			.prepare(
				"INSERT INTO paper_search(paper_row_id, namespace_id, title, authors, venue, abstract, tags, identifiers, user_notes, publication_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				paperRowId,
				this.namespace,
				record.title,
				record.authors.join(" "),
				record.venue ?? "",
				record.abstract ?? "",
				record.curation?.tags.join(" ") ?? "",
				[record.id, ...Object.values(record.identifiers)].filter(Boolean).join(" "),
				record.curation?.userNotes.map((note) => note.text).join(" ") ?? "",
				record.publicationType ?? "",
			);
		this.syncPublicationVersions(database, paperRowId, record);
		return paperRowId;
	}

	async listPapers(): Promise<PaperRecord[]> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "records")))
		)
			return [];
		await this.initialize();
		return this.read((database) =>
			(
				database
					.prepare("SELECT record_json FROM papers WHERE namespace_id = ? ORDER BY paper_id")
					.all(this.namespace) as unknown as Array<{ record_json: string }>
			).map((row) => parseJson<PaperRecord>(row.record_json)),
		);
	}

	async listNamespaces(): Promise<string[]> {
		if (!(await pathExists(this.databasePath))) return [];
		await this.initialize();
		return this.read((database) =>
			(database.prepare("SELECT id FROM namespaces ORDER BY id").all() as unknown as Array<{ id: string }>).map(
				(row) => row.id,
			),
		);
	}

	async getPaper(id: string): Promise<PaperRecord | undefined> {
		if (
			!this.initialized &&
			!(await pathExists(this.databasePath)) &&
			!(await pathExists(join(this.legacyRoot, "records", `${id}.json`)))
		)
			return undefined;
		await this.initialize();
		return this.read((database) => {
			const row = this.paperRow(database, id);
			return row ? parseJson<PaperRecord>(row.record_json) : undefined;
		});
	}

	async savePaper(record: PaperRecord, previousId?: string): Promise<void> {
		await this.initialize();
		const previous = previousId ? await this.getPaper(previousId) : await this.getPaper(record.id);
		this.write((database) => this.syncPaper(database, record, previousId));
		if (previous) {
			const warnings = await this.renamePaperFiles(record.id, record.title);
			if (warnings.length)
				throw new Error(`Paper metadata was saved, but PDF rename failed: ${warnings.join("; ")}`);
		}
	}
}
