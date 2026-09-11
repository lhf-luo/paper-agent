import type { BackgroundJobStatus } from "../domain/background-job.ts";

export interface PersistedJobRow {
	id: string;
	type: string;
	status: BackgroundJobStatus;
	input_json: string;
	result_json: string | null;
	error: string | null;
	progress: number;
	message: string | null;
	attempts: number;
	max_attempts: number;
	created_at: string;
	updated_at: string;
	checkpoint_json: string | null;
}

export function executionPermitOperationId(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const permit = (input as { executionPermit?: unknown }).executionPermit;
	if (!permit || typeof permit !== "object") return undefined;
	const candidate = permit as Record<string, unknown>;
	return typeof candidate.operationId === "string" &&
		typeof candidate.manifestFingerprint === "string" &&
		typeof candidate.authorizedAt === "string" &&
		typeof candidate.signature === "string"
		? candidate.operationId
		: undefined;
}
