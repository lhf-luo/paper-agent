import { PersonalDatabaseAdmin } from "./personal-database-admin.ts";

export type {
	PersonalBlob,
	PersonalLocalImportInput,
	PersonalLocalImportResult,
} from "./personal-database-support.ts";

export class PersonalCorpusDatabase extends PersonalDatabaseAdmin {}
