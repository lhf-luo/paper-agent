export type BackgroundJobStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface BackgroundJob<TInput = unknown, TResult = unknown> {
	id: string;
	type: string;
	status: BackgroundJobStatus;
	input: TInput;
	result?: TResult;
	error?: string;
	progress: number;
	message?: string;
	attempts: number;
	maxAttempts: number;
	createdAt: string;
	updatedAt: string;
	checkpoint?: unknown;
}

export interface BackgroundJobContext {
	jobId: string;
	signal: AbortSignal;
	report(progress: number, message?: string): void;
	checkpoint?<T = unknown>(): T | undefined;
	saveCheckpoint?(value: unknown): void;
}

export type BackgroundJobHandler<TInput = unknown, TResult = unknown> = (
	input: TInput,
	context: BackgroundJobContext,
) => Promise<TResult>;

export class RetryableJobError extends Error {}
