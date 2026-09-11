import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	WikiEvidence,
	WikiPage,
	WikiPageSummary,
	WikiSearchBackend,
	WikiSearchOptions,
	WikiSearchResult,
} from "../domain/wiki-types.ts";
import {
	type WikiLinkRow,
	type WikiNeighborRow,
	type WikiRankRow,
	chunks,
	emptySync,
	evidenceIdsFromText,
	filtersSql,
	normalizeLabel,
	parseLocator,
	parseStrings,
	searchExpression,
} from "./wiki-index-support.ts";

interface WikiPageRow {
	id: string;
	namespace_id: string;
	relative_path: string;
	title: string;
	page_type: string;
	status: string;
	aliases_json: string;
	tags_json: string;
	content_hash: string;
	created_at: string;
	updated_at: string;
}

interface WikiSourceRow {
	evidence_id: string;
	kind: string;
	source_id: string | null;
	paper_id: string | null;
	source_version: string | null;
	locator_json: string;
	legacy: number;
}

const currentSchemaVersion = 2;

export class WikiIndex implements WikiSearchBackend {
	private readonly databasePath: string;

	constructor(databasePath: string) {
		this.databasePath = databasePath;
	}

	private open(): DatabaseSync {
		const database = new DatabaseSync(this.databasePath);
		const version = Number(
			(database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0,
		);
		if (version !== currentSchemaVersion) {
			database.exec(`
				DROP TABLE IF EXISTS wiki_claim_evidence;
				DROP TABLE IF EXISTS wiki_claims;
				DROP TABLE IF EXISTS wiki_page_sources;
				DROP TABLE IF EXISTS wiki_links;
				DROP TABLE IF EXISTS wiki_chunks;
				DROP TABLE IF EXISTS wiki_search;
				DROP TABLE IF EXISTS wiki_chunk_search;
				DROP TABLE IF EXISTS wiki_pages;
			`);
		}
		database.exec(`
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 15000;
			CREATE TABLE IF NOT EXISTS wiki_pages (
				id TEXT NOT NULL,
				namespace_id TEXT NOT NULL,
				relative_path TEXT NOT NULL,
				title TEXT NOT NULL,
				page_type TEXT NOT NULL,
				status TEXT NOT NULL,
				aliases_json TEXT NOT NULL,
				tags_json TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY(namespace_id, id),
				UNIQUE(namespace_id, relative_path)
			);
			CREATE TABLE IF NOT EXISTS wiki_page_sources (
				namespace_id TEXT NOT NULL,
				page_id TEXT NOT NULL,
				evidence_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				source_id TEXT,
				paper_id TEXT,
				source_version TEXT,
				locator_json TEXT NOT NULL,
				legacy INTEGER NOT NULL DEFAULT 0,
				position INTEGER NOT NULL,
				PRIMARY KEY(namespace_id, page_id, evidence_id),
				FOREIGN KEY(namespace_id, page_id) REFERENCES wiki_pages(namespace_id, id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS wiki_claims (
				namespace_id TEXT NOT NULL,
				page_id TEXT NOT NULL,
				claim_id TEXT NOT NULL,
				position INTEGER NOT NULL,
				text TEXT NOT NULL,
				inferred INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY(namespace_id, page_id, claim_id),
				FOREIGN KEY(namespace_id, page_id) REFERENCES wiki_pages(namespace_id, id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS wiki_claim_evidence (
				namespace_id TEXT NOT NULL,
				page_id TEXT NOT NULL,
				claim_id TEXT NOT NULL,
				evidence_id TEXT NOT NULL,
				position INTEGER NOT NULL,
				PRIMARY KEY(namespace_id, page_id, claim_id, evidence_id),
				FOREIGN KEY(namespace_id, page_id, claim_id)
					REFERENCES wiki_claims(namespace_id, page_id, claim_id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS wiki_links (
				namespace_id TEXT NOT NULL,
				source_page_id TEXT NOT NULL,
				target_title TEXT NOT NULL,
				position INTEGER NOT NULL,
				FOREIGN KEY(namespace_id, source_page_id) REFERENCES wiki_pages(namespace_id, id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS wiki_chunks (
				namespace_id TEXT NOT NULL,
				page_id TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				heading TEXT,
				content TEXT NOT NULL,
				PRIMARY KEY(namespace_id, page_id, chunk_index),
				FOREIGN KEY(namespace_id, page_id) REFERENCES wiki_pages(namespace_id, id) ON DELETE CASCADE
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS wiki_search USING fts5(
				namespace_id UNINDEXED,
				page_id UNINDEXED,
				title,
				aliases,
				tags,
				body,
				tokenize='unicode61 remove_diacritics 2'
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS wiki_chunk_search USING fts5(
				namespace_id UNINDEXED,
				page_id UNINDEXED,
				chunk_index UNINDEXED,
				heading,
				content,
				tokenize='unicode61 remove_diacritics 2'
			);
			PRAGMA user_version = ${currentSchemaVersion};
		`);
		return database;
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.databasePath), { recursive: true });
		this.open().close();
	}

	async replaceNamespace(namespace: string, pages: WikiPage[]): Promise<void> {
		await this.initialize();
		const database = this.open();
		try {
			database.exec("BEGIN IMMEDIATE");
			for (const table of [
				"wiki_claim_evidence",
				"wiki_claims",
				"wiki_page_sources",
				"wiki_links",
				"wiki_chunks",
				"wiki_search",
				"wiki_chunk_search",
				"wiki_pages",
			]) {
				database.prepare(`DELETE FROM ${table} WHERE namespace_id = ?`).run(namespace);
			}
			const insertPage = database.prepare(`INSERT INTO wiki_pages(
				id, namespace_id, relative_path, title, page_type, status, aliases_json, tags_json,
				content_hash, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			const insertEvidence = database.prepare(`INSERT INTO wiki_page_sources(
				namespace_id, page_id, evidence_id, kind, source_id, paper_id, source_version,
				locator_json, legacy, position
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			const insertClaim = database.prepare(`INSERT INTO wiki_claims(
				namespace_id, page_id, claim_id, position, text, inferred
			) VALUES (?, ?, ?, ?, ?, ?)`);
			const insertClaimEvidence = database.prepare(`INSERT INTO wiki_claim_evidence(
				namespace_id, page_id, claim_id, evidence_id, position
			) VALUES (?, ?, ?, ?, ?)`);
			const insertLink = database.prepare(
				"INSERT INTO wiki_links(namespace_id, source_page_id, target_title, position) VALUES (?, ?, ?, ?)",
			);
			const insertChunk = database.prepare(
				"INSERT INTO wiki_chunks(namespace_id, page_id, chunk_index, heading, content) VALUES (?, ?, ?, ?, ?)",
			);
			const insertPageSearch = database.prepare(
				"INSERT INTO wiki_search(namespace_id, page_id, title, aliases, tags, body) VALUES (?, ?, ?, ?, ?, ?)",
			);
			const insertChunkSearch = database.prepare(
				"INSERT INTO wiki_chunk_search(namespace_id, page_id, chunk_index, heading, content) VALUES (?, ?, ?, ?, ?)",
			);
			for (const page of pages) {
				insertPage.run(
					page.id,
					namespace,
					page.relativePath,
					page.title,
					page.type,
					page.status,
					JSON.stringify(page.aliases),
					JSON.stringify(page.tags),
					page.contentHash,
					page.createdAt,
					page.updatedAt,
				);
				page.evidence.forEach((evidence, position) => {
					insertEvidence.run(
						namespace,
						page.id,
						evidence.id,
						evidence.kind,
						evidence.sourceId ?? null,
						evidence.paperId ?? null,
						evidence.version ?? null,
						JSON.stringify(evidence.locator),
						evidence.legacy ? 1 : 0,
						position,
					);
				});
				page.claims.forEach((claim, claimPosition) => {
					insertClaim.run(namespace, page.id, claim.id, claimPosition, claim.text, claim.inferred ? 1 : 0);
					claim.evidenceIds.forEach((evidenceId, evidencePosition) => {
						insertClaimEvidence.run(namespace, page.id, claim.id, evidenceId, evidencePosition);
					});
				});
				page.links.forEach((title, position) => {
					insertLink.run(namespace, page.id, title, position);
				});
				chunks(page.markdown).forEach((chunk, index) => {
					insertChunk.run(namespace, page.id, index, chunk.heading ?? null, chunk.content);
					insertChunkSearch.run(
						namespace,
						page.id,
						index,
						chunk.heading ?? "",
						chunk.content,
					);
				});
				insertPageSearch.run(
					namespace,
					page.id,
					page.title,
					page.aliases.join(" "),
					page.tags.join(" "),
					page.markdown,
				);
			}
			database.exec("COMMIT");
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {}
			throw error;
		} finally {
			database.close();
		}
	}

	async search(namespace: string, options: WikiSearchOptions = {}): Promise<WikiSearchResult> {
		await this.initialize();
		const database = this.open();
		try {
			const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
			const expression = options.query ? searchExpression(options.query) : undefined;
			const filter = filtersSql(options);
			const rows = database
				.prepare(`SELECT p.* FROM wiki_pages p WHERE p.namespace_id = ?${filter.sql} ORDER BY p.updated_at DESC LIMIT 1000`)
				.all(namespace, ...filter.params) as unknown as WikiPageRow[];
			const byId = new Map(rows.map((row) => [row.id, row]));
			if (options.pageId) {
				const row = byId.get(options.pageId);
				return {
					namespace,
					pages: row ? [await this.summary(database, namespace, row)] : [],
					sync: emptySync(rows.length),
				};
			}
			if (!expression) {
				if (options.query) {
					return { namespace, pages: [], sync: emptySync(rows.length) };
				}
				const pages = rows.slice(0, limit).map((row) => this.summarySync(database, namespace, row));
				if (options.includeRelated && pages.length) {
					const related = await this.relatedSummaries(database, namespace, pages, byId, limit);
					for (const page of related) if (!pages.some((item) => item.id === page.id)) pages.push(page);
				}
				return { namespace, pages: pages.slice(0, limit), sync: emptySync(rows.length) };
			}

			const pageRanks = database
				.prepare(`SELECT s.page_id, bm25(wiki_search, 0, 0, 8, 3, 2, 1) AS rank,
						snippet(wiki_search, 5, '<mark>', '</mark>', ' … ', 18) AS snippet
					FROM wiki_search s
					JOIN wiki_pages p ON p.namespace_id = s.namespace_id AND p.id = s.page_id
					WHERE wiki_search MATCH ? AND s.namespace_id = ?${filter.sql}
					ORDER BY rank LIMIT 200`)
				.all(expression, namespace, ...filter.params) as unknown as WikiRankRow[];
			const chunkRanks = database
				.prepare(`SELECT c.page_id, c.heading, c.chunk_index,
						bm25(wiki_chunk_search, 0, 0, 0, 4, 1) AS rank,
						snippet(wiki_chunk_search, 4, '<mark>', '</mark>', ' … ', 24) AS snippet
					FROM wiki_chunk_search c
					JOIN wiki_pages p ON p.namespace_id = c.namespace_id AND p.id = c.page_id
					WHERE wiki_chunk_search MATCH ? AND c.namespace_id = ?${filter.sql}
					ORDER BY rank LIMIT 300`)
				.all(expression, namespace, ...filter.params) as unknown as WikiRankRow[];

			const scored = new Map<string, { row: WikiPageRow; score: number; match: WikiPageSummary["match"] }>();
			const queryNormalized = normalizeLabel(options.query ?? "");
			for (const row of rows) {
				const labels = [row.title, ...parseStrings(row.aliases_json)];
				const exact = labels.some((label) => normalizeLabel(label) === queryNormalized);
				const alias = labels.slice(1).some((label) => normalizeLabel(label).includes(queryNormalized));
				const score = exact ? 1_000 : alias ? 900 : 1;
				scored.set(row.id, {
					row,
					score,
					match: {
						reason: exact ? "title" : alias ? "alias" : "chunk",
						score,
						evidenceIds: [],
					},
				});
			}
			pageRanks.forEach((rank, index) => {
				const current = scored.get(rank.page_id);
				if (!current) return;
				const score = Math.max(current.score, 500 - index * 4 + Math.min(80, Math.abs(rank.rank)));
				current.score = score;
				if (rank.snippet) {
					current.match = {
						reason: "chunk",
						score,
						...(current.match?.heading ? { heading: current.match.heading } : {}),
						snippet: rank.snippet,
						evidenceIds: [],
					};
				}
			});
			chunkRanks.forEach((rank, index) => {
				const current = scored.get(rank.page_id);
				if (!current) return;
				const score = 300 - index * 2 + Math.min(60, Math.abs(rank.rank));
				if (score > current.score || !current.match?.heading) {
					current.score = score;
					current.match = {
						reason: "chunk",
						score,
						heading: rank.heading,
						snippet: rank.snippet,
						evidenceIds: evidenceIdsFromText(rank.snippet ?? ""),
					};
				}
			});
			const result = [...scored.values()]
				.filter((item) => item.score > 1 || queryNormalized.includes(normalizeLabel(item.row.title)))
				.sort((left, right) => right.score - left.score || right.row.updated_at.localeCompare(left.row.updated_at))
				.slice(0, limit)
				.map((item) => this.summarySync(database, namespace, item.row, item.match));
			if (options.includeRelated && result.length) {
				for (const page of await this.relatedSummaries(database, namespace, result, byId, limit)) {
					if (!result.some((item) => item.id === page.id)) result.push(page);
				}
			}
			return { namespace, pages: result.slice(0, limit), sync: emptySync(rows.length) };
		} finally {
			database.close();
		}
	}

	async list(namespace: string, query?: string, limit = 100): Promise<WikiPageSummary[]> {
		return (await this.search(namespace, { query, limit })).pages;
	}

	async count(namespace: string): Promise<number> {
		await this.initialize();
		const database = this.open();
		try {
			return Number(
				(database.prepare("SELECT COUNT(*) AS count FROM wiki_pages WHERE namespace_id = ?").get(namespace) as {
					count: number;
				}).count,
			);
		} finally {
			database.close();
		}
	}

	async pathFor(namespace: string, id: string): Promise<string | undefined> {
		await this.initialize();
		const database = this.open();
		try {
			return (
				database
					.prepare("SELECT relative_path FROM wiki_pages WHERE namespace_id = ? AND id = ?")
					.get(namespace, id) as { relative_path: string } | undefined
			)?.relative_path;
		} finally {
			database.close();
		}
	}

	async backlinks(namespace: string, titles: string[]): Promise<Array<{ id: string; title: string }>> {
		await this.initialize();
		const database = this.open();
		try {
			if (!titles.length) return [];
			const normalized = new Set(titles.map(normalizeLabel));
			const links = database
				.prepare("SELECT source_page_id, target_title FROM wiki_links WHERE namespace_id = ?")
				.all(namespace) as unknown as WikiLinkRow[];
			const sourceIds = [
				...new Set(links.filter((link) => normalized.has(normalizeLabel(link.target_title))).map((link) => link.source_page_id)),
			];
			if (!sourceIds.length) return [];
			const placeholders = sourceIds.map(() => "?").join(", ");
			return database
				.prepare(`SELECT id, title FROM wiki_pages WHERE namespace_id = ? AND id IN (${placeholders}) ORDER BY title`)
				.all(namespace, ...sourceIds) as unknown as Array<{ id: string; title: string }>;
		} finally {
			database.close();
		}
	}

	async neighbors(namespace: string, pageId: string, limit = 20): Promise<WikiPageSummary[]> {
		await this.initialize();
		const database = this.open();
		try {
			const rows = database
				.prepare("SELECT id, title, aliases_json FROM wiki_pages WHERE namespace_id = ?")
				.all(namespace) as unknown as WikiNeighborRow[];
			const page = rows.find((row) => row.id === pageId);
			if (!page) return [];
			const labels = new Set([page.title, ...parseStrings(page.aliases_json)].map(normalizeLabel));
			const links = database
				.prepare("SELECT source_page_id, target_title FROM wiki_links WHERE namespace_id = ?")
				.all(namespace) as unknown as WikiLinkRow[];
			const ids = new Set<string>();
			for (const link of links) {
				if (link.source_page_id === pageId && labels.has(normalizeLabel(link.target_title))) continue;
				const target = rows.find(
					(row) => row.id !== pageId && normalizeLabel(link.target_title) === normalizeLabel(row.title),
				);
				if (link.source_page_id === pageId && target) {
					ids.add(target.id);
					continue;
				}
				if (link.source_page_id !== pageId && labels.has(normalizeLabel(link.target_title))) ids.add(link.source_page_id);
			}
			return rows
				.filter((row) => ids.has(row.id))
				.slice(0, limit)
				.map((row) => {
					const full = database.prepare("SELECT * FROM wiki_pages WHERE namespace_id = ? AND id = ?").get(namespace, row.id) as
						| WikiPageRow
						| undefined;
					return full ? this.summarySync(database, namespace, full, { reason: "related", score: 50, evidenceIds: [] }) : undefined;
				})
				.filter((item): item is WikiPageSummary => Boolean(item));
		} finally {
			database.close();
		}
	}

	private async relatedSummaries(
		database: DatabaseSync,
		namespace: string,
		pages: WikiPageSummary[],
		byId: Map<string, WikiPageRow>,
		limit: number,
	): Promise<WikiPageSummary[]> {
		const result: WikiPageSummary[] = [];
		for (const page of pages.slice(0, 5)) {
			const related = await this.neighborsWithDatabase(database, namespace, page.id, limit);
			for (const item of related) {
				if (!byId.has(item.id) || pages.some((existing) => existing.id === item.id)) continue;
				if (!result.some((existing) => existing.id === item.id)) result.push(item);
			}
		}
		return result;
	}

	private async neighborsWithDatabase(
		database: DatabaseSync,
		namespace: string,
		pageId: string,
		limit: number,
	): Promise<WikiPageSummary[]> {
		const rows = database
			.prepare("SELECT * FROM wiki_pages WHERE namespace_id = ?")
			.all(namespace) as unknown as WikiPageRow[];
		const page = rows.find((row) => row.id === pageId);
		if (!page) return [];
		const labels = new Set([page.title, ...parseStrings(page.aliases_json)].map(normalizeLabel));
		const links = database
			.prepare("SELECT source_page_id, target_title FROM wiki_links WHERE namespace_id = ?")
			.all(namespace) as unknown as WikiLinkRow[];
		const ids = new Set<string>();
		for (const link of links) {
			if (link.source_page_id === pageId) {
				const target = rows.find((row) => row.id !== pageId && normalizeLabel(row.title) === normalizeLabel(link.target_title));
				if (target) ids.add(target.id);
			}
			if (link.source_page_id !== pageId && labels.has(normalizeLabel(link.target_title))) ids.add(link.source_page_id);
		}
		return rows
			.filter((row) => ids.has(row.id))
			.slice(0, limit)
			.map((row) => this.summarySync(database, namespace, row, { reason: "related", score: 50, evidenceIds: [] }));
	}

	private async summary(
		database: DatabaseSync,
		namespace: string,
		row: WikiPageRow,
		match?: WikiPageSummary["match"],
	): Promise<WikiPageSummary> {
		return this.summarySync(database, namespace, row, match);
	}

	private summarySync(
		database: DatabaseSync,
		namespace: string,
		row: WikiPageRow,
		match?: WikiPageSummary["match"],
	): WikiPageSummary {
		const sources = database
			.prepare(`SELECT evidence_id, kind, source_id, paper_id, source_version, locator_json, legacy
				FROM wiki_page_sources WHERE namespace_id = ? AND page_id = ? ORDER BY position`)
			.all(namespace, row.id) as unknown as WikiSourceRow[];
		const evidence = sources.map((source) => ({
			id: source.evidence_id,
			kind: source.kind as WikiEvidence["kind"],
			...(source.source_id ? { sourceId: source.source_id } : {}),
			...(source.paper_id ? { paperId: source.paper_id } : {}),
			...(source.source_version ? { version: source.source_version } : {}),
			locator: parseLocator(source.locator_json),
			...(source.legacy ? { legacy: true } : {}),
		}));
		const sourceNoteIds = [
			...new Set(evidence.filter((item) => item.kind === "note" && item.sourceId).map((item) => item.sourceId!)),
		];
		const paperIds = [
			...new Set(
				evidence.flatMap((item) => [item.kind === "paper" ? item.sourceId : undefined, item.paperId]).filter(
					(value): value is string => Boolean(value),
				),
			),
		];
		return {
			id: row.id,
			title: row.title,
			type: row.page_type as WikiPageSummary["type"],
			status: row.status as WikiPageSummary["status"],
			relativePath: row.relative_path,
			aliases: parseStrings(row.aliases_json),
			tags: parseStrings(row.tags_json),
			sourceNoteIds,
			paperIds,
			evidence,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			contentHash: row.content_hash,
			...(match ? { match } : {}),
		};
	}
}
