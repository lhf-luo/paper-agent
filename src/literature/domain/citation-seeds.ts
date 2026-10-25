import type { PaperRecord } from "./literature-types.ts";
import { mergePaperRecords } from "./literature-identifiers.ts";
import { samePaper } from "./reliable-paper-identity.ts";
/** Stable first-record identity; never merge on title or author alone. */
export function unionPapers(records: PaperRecord[]): PaperRecord[] {
	const result: PaperRecord[] = [];
	for (const record of records) {
		const matches = result.filter((p) => samePaper(p, record));
		if (!matches.length) {
			result.push(structuredClone(record));
			continue;
		}
		const first = matches[0];
		let merged = mergePaperRecords(first, record);
		for (const duplicate of matches.slice(1)) {
			merged = mergePaperRecords(merged, duplicate);
			result.splice(result.indexOf(duplicate), 1);
		}
		result[result.indexOf(first)] = merged;
	}
	return result;
}
