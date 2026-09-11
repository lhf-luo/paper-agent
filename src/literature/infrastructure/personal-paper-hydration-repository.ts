import type { DatabaseSync } from "node:sqlite";
import { PersonalDatabaseBase } from "./personal-database-base.ts";
import type { PaperRow } from "./personal-database-support.ts";

export abstract class PersonalPaperHydrationRepository extends PersonalDatabaseBase {
	protected paperRow(database: DatabaseSync, paperId: string): PaperRow | undefined {
		return database
			.prepare("SELECT row_id, paper_id, title, record_json FROM papers WHERE namespace_id = ? AND paper_id = ?")
			.get(this.namespace, paperId) as PaperRow | undefined;
	}
}
