import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
}

export interface BackgroundJobContext {
	jobId: string;
	signal: AbortSignal;
	report(progress: number, message?: string): void;
}

export type BackgroundJobHandler<TInput = unknown, TResult = unknown> = (
	input: TInput,
	context: BackgroundJobContext,
) => Promise<TResult>;

export class RetryableJobError extends Error {}

interface PersistedJobRow {
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
}

function executionPermitOperationId(input: unknown): string | undefined {
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

export class PersistentJobQueue {
	private readonly databasePath: string;
	private readonly concurrency: number;
	private database?: DatabaseSync;
	private readonly handlers = new Map<string, BackgroundJobHandler>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly resumeRequested = new Set<string>();
	private readonly listeners = new Set<(job: BackgroundJob) => void>();
	private active = 0;
	private pumping = false;
	private stopping = false;

	constructor(databasePath: string, concurrency = 2) {
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
			throw new Error("Job queue concurrency must be an integer between 1 and 32");
		}
		this.databasePath = databasePath;
		this.concurrency = concurrency;
	}

	async initialize(): Promise<void> {
		if (this.database) return;
		if (this.databasePath !== ":memory:") await mkdir(dirname(this.databasePath), { recursive: true });
		this.database = new DatabaseSync(this.databasePath);
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS background_jobs (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				status TEXT NOT NULL,
				input_json TEXT NOT NULL,
				result_json TEXT,
				error TEXT,
				progress REAL NOT NULL DEFAULT 0,
				message TEXT,
				attempts INTEGER NOT NULL DEFAULT 0,
				max_attempts INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
				CREATE INDEX IF NOT EXISTS background_jobs_status_created
				ON background_jobs(status, created_at);
				CREATE TABLE IF NOT EXISTS background_job_operation_claims (
					operation_id TEXT PRIMARY KEY,
					job_id TEXT NOT NULL UNIQUE,
					claimed_at TEXT NOT NULL
				);
			`);
		const claim = this.database.prepare(
			"INSERT OR IGNORE INTO background_job_operation_claims(operation_id, job_id, claimed_at) VALUES (?, ?, ?)",
		);
		const existingJobs = this.database
			.prepare("SELECT id, input_json, created_at FROM background_jobs ORDER BY created_at ASC")
			.all() as unknown as Array<{ id: string; input_json: string; created_at: string }>;
		for (const row of existingJobs) {
			try {
				const operationId = executionPermitOperationId(JSON.parse(row.input_json));
				if (operationId) claim.run(operationId, row.id, row.created_at);
			} catch {
				// Invalid input JSON is reported when the job is read or executed.
			}
		}
		this.database
			.prepare(
				"UPDATE background_jobs SET status = 'queued', message = 'resumed after process restart' WHERE status = 'running'",
			)
			.run();
		this.schedulePump();
	}

	register<TInput, TResult>(type: string, handler: BackgroundJobHandler<TInput, TResult>): void {
		if (!type.trim()) throw new Error("Job type is required");
		if (this.handlers.has(type)) throw new Error(`Job handler is already registered: ${type}`);
		this.handlers.set(type, handler as BackgroundJobHandler);
		this.schedulePump();
	}

	async enqueue<TInput>(
		type: string,
		input: TInput,
		options: { maxAttempts?: number } = {},
	): Promise<BackgroundJob<TInput>> {
		await this.initialize();
		const maxAttempts = options.maxAttempts ?? 1;
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
			throw new Error("maxAttempts must be an integer between 1 and 20");
		}
		const now = new Date().toISOString();
		const job: BackgroundJob<TInput> = {
			id: `job-${randomUUID()}`,
			type,
			status: "queued",
			input,
			progress: 0,
			attempts: 0,
			maxAttempts,
			createdAt: now,
			updatedAt: now,
		};
		const database = this.requireDatabase();
		const operationId = executionPermitOperationId(input);
		database.exec("BEGIN IMMEDIATE");
		try {
			database
				.prepare(
					`INSERT INTO background_jobs
					(id, type, status, input_json, progress, attempts, max_attempts, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(job.id, job.type, job.status, JSON.stringify(input), job.progress, 0, maxAttempts, now, now);
			if (operationId) {
				database
					.prepare(
						"INSERT INTO background_job_operation_claims(operation_id, job_id, claimed_at) VALUES (?, ?, ?)",
					)
					.run(operationId, job.id, now);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			if (operationId && String(error).includes("UNIQUE constraint failed")) {
				throw new Error("This confirmed operation is already assigned to another background job");
			}
			throw error;
		}
		this.emit(job);
		this.schedulePump();
		return job;
	}

	get(id: string): BackgroundJob | undefined {
		const row = this.requireDatabase().prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as
			| PersistedJobRow
			| undefined;
		return row ? this.fromRow(row) : undefined;
	}

	list(options: { status?: BackgroundJobStatus; limit?: number } = {}): BackgroundJob[] {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
		const rows = options.status
			? (this.requireDatabase()
					.prepare("SELECT * FROM background_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?")
					.all(options.status, limit) as unknown as PersistedJobRow[])
			: (this.requireDatabase()
					.prepare("SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?")
					.all(limit) as unknown as PersistedJobRow[]);
		return rows.map((row) => this.fromRow(row));
	}

	async pause(id: string): Promise<BackgroundJob> {
		const job = this.requiredJob(id);
		if (job.status === "queued") this.update(id, { status: "paused", message: "paused by user" });
		else if (job.status === "running") {
			this.update(id, { status: "paused", message: "pausing" });
			this.controllers.get(id)?.abort();
		} else if (job.status !== "paused") throw new Error(`Cannot pause a ${job.status} job`);
		return this.requiredJob(id);
	}

	async resume(id: string): Promise<BackgroundJob> {
		const job = this.requiredJob(id);
		if (job.status !== "paused") throw new Error(`Cannot resume a ${job.status} job`);
		if (this.controllers.has(id)) {
			this.resumeRequested.add(id);
			this.update(id, { message: "resume requested; waiting for the current execution to stop" });
		} else {
			this.update(id, { status: "queued", message: "resumed by user" });
			this.schedulePump();
		}
		return this.requiredJob(id);
	}

	async cancel(id: string): Promise<BackgroundJob> {
		const job = this.requiredJob(id);
		if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
		this.resumeRequested.delete(id);
		this.update(id, { status: "cancelled", message: "cancelled by user" });
		this.controllers.get(id)?.abort();
		return this.requiredJob(id);
	}

	async retry<TInput = unknown>(id: string, inputOverride?: TInput): Promise<BackgroundJob<TInput>> {
		const job = this.requiredJob(id);
		if (!["succeeded", "failed", "cancelled"].includes(job.status)) {
			throw new Error(`Cannot retry a ${job.status} job`);
		}
		return this.enqueue(job.type, inputOverride === undefined ? (job.input as TInput) : inputOverride, {
			maxAttempts: job.maxAttempts,
		});
	}

	subscribe(listener: (job: BackgroundJob) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const controller of this.controllers.values()) controller.abort();
		while (this.active > 0) await new Promise((resolve) => setTimeout(resolve, 10));
		this.database?.close();
		this.database = undefined;
	}

	private requireDatabase(): DatabaseSync {
		if (!this.database) throw new Error("Job queue is not initialized");
		return this.database;
	}

	private requiredJob(id: string): BackgroundJob {
		const job = this.get(id);
		if (!job) throw new Error(`Background job not found: ${id}`);
		return job;
	}

	private fromRow(row: PersistedJobRow): BackgroundJob {
		return {
			id: row.id,
			type: row.type,
			status: row.status,
			input: JSON.parse(row.input_json) as unknown,
			result: row.result_json === null ? undefined : (JSON.parse(row.result_json) as unknown),
			error: row.error ?? undefined,
			progress: row.progress,
			message: row.message ?? undefined,
			attempts: row.attempts,
			maxAttempts: row.max_attempts,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private update(
		id: string,
		changes: Partial<Pick<BackgroundJob, "status" | "result" | "error" | "progress" | "message" | "attempts">>,
	): void {
		const current = this.requiredJob(id);
		const updated = { ...current, ...changes, updatedAt: new Date().toISOString() };
		this.requireDatabase()
			.prepare(
				`UPDATE background_jobs SET status = ?, result_json = ?, error = ?, progress = ?, message = ?, attempts = ?, updated_at = ?
				WHERE id = ?`,
			)
			.run(
				updated.status,
				updated.result === undefined ? null : JSON.stringify(updated.result),
				updated.error ?? null,
				updated.progress,
				updated.message ?? null,
				updated.attempts,
				updated.updatedAt,
				id,
			);
		this.emit(updated);
	}

	private emit(job: BackgroundJob): void {
		for (const listener of this.listeners) listener(job);
	}

	private schedulePump(): void {
		if (this.pumping || this.stopping || !this.database) return;
		this.pumping = true;
		queueMicrotask(() => {
			this.pumping = false;
			void this.pump();
		});
	}

	private async pump(): Promise<void> {
		while (!this.stopping && this.active < this.concurrency) {
			const row = this.requireDatabase()
				.prepare("SELECT * FROM background_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
				.get() as PersistedJobRow | undefined;
			if (!row) return;
			const handler = this.handlers.get(row.type);
			if (!handler) return;
			this.active++;
			void this.run(this.fromRow(row), handler).finally(() => {
				this.active--;
				this.schedulePump();
			});
		}
	}

	private async run(job: BackgroundJob, handler: BackgroundJobHandler): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(job.id, controller);
		this.update(job.id, {
			status: "running",
			attempts: job.attempts + 1,
			error: undefined,
			message: "running",
		});
		try {
			const result = await handler(job.input, {
				jobId: job.id,
				signal: controller.signal,
				report: (progress, message) => {
					const current = this.get(job.id);
					if (!current || current.status !== "running") return;
					this.update(job.id, { progress: Math.min(Math.max(progress, 0), 1), message });
				},
			});
			const current = this.requiredJob(job.id);
			if (current.status === "cancelled" || current.status === "paused") return;
			this.update(job.id, { status: "succeeded", result, progress: 1, message: "completed" });
		} catch (error) {
			const current = this.requiredJob(job.id);
			if (current.status === "cancelled" || current.status === "paused") return;
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof RetryableJobError && current.attempts < current.maxAttempts) {
				this.update(job.id, { status: "queued", error: message, message: "retry scheduled" });
			} else {
				this.update(job.id, { status: "failed", error: message, message: "failed" });
			}
		} finally {
			if (this.controllers.get(job.id) === controller) this.controllers.delete(job.id);
			if (this.resumeRequested.delete(job.id)) {
				const current = this.get(job.id);
				if (current?.status === "paused") {
					this.update(job.id, { status: "queued", message: "resumed after the previous execution stopped" });
					this.schedulePump();
				}
			}
		}
	}
}
