import { createHash } from "node:crypto";
import type { LiteratureStore } from "./literature-store.ts";
import type { DerivedRecord, PaperRecord } from "./literature-types.ts";
import {
	authorizeOperationExecution,
	type OperationExecutionAuthorization,
	type OperationPlan,
} from "./operation-consent.ts";

export function corpusUpsertPlan(store: LiteratureStore, records: PaperRecord[]): OperationPlan {
	const normalized = [...records].sort((left, right) => left.id.localeCompare(right.id));
	const recordsFingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
	return {
		kind: "personal-corpus-write",
		summary: `Save ${records.length} literature records to ${store.scope}/${store.namespace}`,
		targets: [{ label: "corpus", value: store.root, risk: store.scope === "team" ? "high" : "medium" }],
		details: {
			recordIds: normalized.map((record) => record.id),
			recordsFingerprint,
			corpusPath: store.root,
			scope: store.scope,
			namespace: store.namespace,
		},
	};
}

export async function persistPaperRecords(
	store: LiteratureStore,
	records: PaperRecord[],
	authorization: OperationExecutionAuthorization,
) {
	await authorizeOperationExecution(authorization, corpusUpsertPlan(store, records));
	return store.upsertPapers(records);
}

export function derivedRecordWritePlan(store: LiteratureStore, record: DerivedRecord): OperationPlan {
	const recordFingerprint = createHash("sha256").update(JSON.stringify(record)).digest("hex");
	return {
		kind: "research-memory-write",
		summary: `Record derived research memory ${record.operation} for ${record.paperId}`,
		targets: [{ label: "derived-memory", value: `${store.root}/${record.key}`, risk: "medium" }],
		details: {
			key: record.key,
			paperId: record.paperId,
			operation: record.operation,
			recordFingerprint,
			corpusPath: store.root,
			scope: store.scope,
			namespace: store.namespace,
		},
	};
}

export async function persistDerivedRecord(
	store: LiteratureStore,
	record: DerivedRecord,
	authorization: OperationExecutionAuthorization,
) {
	await authorizeOperationExecution(authorization, derivedRecordWritePlan(store, record));
	return store.putDerived(record);
}

export async function runAuthorizedMutation<T>(
	authorization: OperationExecutionAuthorization,
	plan: OperationPlan,
	mutation: () => Promise<T>,
): Promise<T> {
	await authorizeOperationExecution(authorization, plan);
	return mutation();
}
