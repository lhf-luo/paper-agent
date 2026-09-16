import type { DatabaseSync } from "node:sqlite";
import { PersonalDatabaseBase } from "./personal-database-base.ts";
import type { PaperRow } from "./personal-database-support.ts";

export abstract class PersonalPaperHydrationRepository extends PersonalDatabaseBase {
	protected paperRow(database: DatabaseSync, paperId: string): PaperRow | undefined {
		const direct = database
			.prepare("SELECT row_id, paper_id, title, record_json FROM papers WHERE namespace_id = ? AND paper_id = ?")
			.get(this.namespace, paperId) as PaperRow | undefined;
		if (direct) return direct;
		const aliases = database
			.prepare(`SELECT p.row_id, p.paper_id, p.title, p.record_json
				FROM paper_merges m
				JOIN papers p ON p.row_id = m.canonical_paper_row_id
				WHERE p.namespace_id = ? AND lower(m.merged_from_id) = lower(?)
				LIMIT 2`)
			.all(this.namespace, paperId) as unknown as PaperRow[];
		if (aliases.length > 1) throw new Error(`Paper alias is ambiguous: ${paperId}`);
		return aliases[0];
	}
}
