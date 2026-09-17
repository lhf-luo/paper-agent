import { readFilterResult } from "./literature-filter-result.ts";
import { writeLiteratureSidebarResult } from "./literature-sidebar.ts";
import {
	SIDEBAR_ANNOTATION_FIELD_NAMES,
	type SidebarAnnotationField,
	type SidebarField,
	sidebarMetadataFromRecord,
	validateSidebarAnnotationFields,
	validateSidebarFields,
} from "./literature-sidebar-fields.ts";
import { LiteratureStore } from "./literature-store.ts";

export interface FilterSidebarAnnotation {
	paperId: string;
	focus?: string;
	relevance?: string;
	topic?: string;
}

function clean(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

export async function writeSidebarFromFilter(input: {
	cwd: string;
	sessionId?: string;
	filterResultId: string;
	searchRunId: string;
	fields: SidebarField[];
	annotationFields: SidebarAnnotationField[];
	annotations: FilterSidebarAnnotation[];
}): Promise<{
	mdPath: string;
	mdUrl: string;
	rowCount: number;
	revision: number;
	unannotatedCount: number;
	matched: number;
	unresolved: number;
	missingPaperIds: string[];
}> {
	const fields = validateSidebarFields(input.fields);
	const annotationFields = validateSidebarAnnotationFields(fields, input.annotationFields);
	const declaredAnnotationFields = new Set<string>(annotationFields);
	const snapshot = await readFilterResult(input.cwd, input.sessionId, input.filterResultId);
	if (snapshot.searchRunId !== input.searchRunId) {
		throw new Error("filter_result_id and search_run_id do not match");
	}
	if (snapshot.entries.length === 0) throw new Error("Filter result has no retained papers");
	const store = new LiteratureStore(snapshot.corpusRoot, "personal", snapshot.namespace);
	const run = await store.getSearchRun(snapshot.searchRunId);
	if (!run || run.namespace !== snapshot.namespace) {
		throw new Error("Filter result source search run is unavailable; run filter_search_run_results again");
	}
	const byId = new Map(run.results.map((record) => [record.id, record]));
	const selected = new Set<string>();
	const missingPaperIds: string[] = [];
	for (const entry of snapshot.entries) {
		if (selected.has(entry.paperId)) throw new Error(`Duplicate Paper ID in filter result: ${entry.paperId}`);
		selected.add(entry.paperId);
		const record = byId.get(entry.paperId);
		if (!record) {
			missingPaperIds.push(entry.paperId);
			continue;
		}
		if (record.title !== entry.title) {
			throw new Error(`Filter result is stale for Paper ID ${entry.paperId}; run filter_search_run_results again`);
		}
	}
	const annotations = new Map<string, FilterSidebarAnnotation>();
	for (const annotation of input.annotations) {
		for (const key of Object.keys(annotation)) {
			if (key !== "paperId" && !SIDEBAR_ANNOTATION_FIELD_NAMES.includes(key as SidebarAnnotationField)) {
				throw new Error(`Unsupported annotation property: ${key}`);
			}
		}
		if (!selected.has(annotation.paperId)) throw new Error(`Unknown annotation Paper ID: ${annotation.paperId}`);
		if (annotations.has(annotation.paperId)) throw new Error(`Duplicate annotation Paper ID: ${annotation.paperId}`);
		for (const field of SIDEBAR_ANNOTATION_FIELD_NAMES) {
			if (annotation[field] !== undefined && !declaredAnnotationFields.has(field)) {
				throw new Error(`Annotation field was not declared in annotation_fields: ${field}`);
			}
		}
		annotations.set(annotation.paperId, annotation);
	}
	const rows: Array<Record<string, unknown>> = [];
	let unannotatedCount = 0;
	for (const entry of snapshot.entries) {
		const record = byId.get(entry.paperId);
		if (!record) continue;
		const annotation = annotations.get(entry.paperId);
		const annotationValues = Object.fromEntries(
			annotationFields.flatMap((field) => {
				const value = clean(annotation?.[field]);
				return value ? [[field, value]] : [];
			}),
		);
		if (annotationFields.some((field) => !clean(annotation?.[field]))) unannotatedCount += 1;
		rows.push(
			sidebarMetadataFromRecord(record, {
				searchRunId: run.id,
				namespace: snapshot.namespace,
				screeningStatus: entry.status,
				preserved: {
					...annotationValues,
					...(Object.keys(annotationValues).length ? { annotation_basis: "title" } : {}),
				},
			}),
		);
	}
	const result = await writeLiteratureSidebarResult({
		cwd: input.cwd,
		sessionId: input.sessionId,
		fields,
		rows,
	});
	return {
		...result,
		unannotatedCount,
		matched: snapshot.entries.filter((entry) => entry.status === "matched" && byId.has(entry.paperId)).length,
		unresolved: snapshot.entries.filter((entry) => entry.status === "unresolved" && byId.has(entry.paperId)).length,
		missingPaperIds,
	};
}
