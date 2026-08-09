import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentJobQueue, RetryableJobError } from "../src/job-queue.ts";
import {
	authorizeOperationExecution,
	OperationConsentManager,
	type OperationPlan,
} from "../src/operation-consent.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(queue: PersistentJobQueue, id: string, statuses: string[], timeoutMs = 3_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const job = queue.get(id);
		if (job && statuses.includes(job.status)) return job;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for job ${id}`);
}

describe("PersistentJobQueue", () => {
	it("persists progress and successful results", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-jobs-"));
		temporaryPaths.push(root);
		const queue = new PersistentJobQueue(join(root, "jobs.sqlite"));
		await queue.initialize();
		queue.register<{ value: number }, number>("double", async (input, context) => {
			context.report(0.5, "halfway");
			return input.value * 2;
		});
		const queued = await queue.enqueue("double", { value: 4 });
		const completed = await waitFor(queue, queued.id, ["succeeded"]);

		expect(completed.result).toBe(8);
		expect(completed.progress).toBe(1);
		await queue.stop();
	});

	it("retries explicitly retryable failures", async () => {
		const queue = new PersistentJobQueue(":memory:");
		await queue.initialize();
		let attempts = 0;
		queue.register("flaky", async () => {
			attempts++;
			if (attempts === 1) throw new RetryableJobError("temporary provider failure");
			return "ok";
		});
		const queued = await queue.enqueue("flaky", {}, { maxAttempts: 2 });
		const completed = await waitFor(queue, queued.id, ["succeeded"]);

		expect(completed.attempts).toBe(2);
		expect(completed.result).toBe("ok");
		await queue.stop();
	});

	it("pauses, resumes, and cancels queued work", async () => {
		const queue = new PersistentJobQueue(":memory:", 1);
		await queue.initialize();
		queue.register("blocked", async (_input, context) => {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 1_000);
				context.signal.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				});
			});
			return "done";
		});
		const first = await queue.enqueue("blocked", {});
		const second = await queue.enqueue("blocked", {});
		await waitFor(queue, first.id, ["running"]);
		await queue.pause(second.id);
		expect(queue.get(second.id)?.status).toBe("paused");
		await queue.resume(second.id);
		expect(queue.get(second.id)?.status).toBe("queued");
		await queue.cancel(first.id);
		expect(queue.get(first.id)?.status).toBe("cancelled");
		await queue.cancel(second.id);
		await queue.stop();
	});

	it("waits for a paused running handler to exit before starting its resumed execution", async () => {
		const queue = new PersistentJobQueue(":memory:", 1);
		await queue.initialize();
		let runs = 0;
		let releaseFirst!: () => void;
		const firstMayExit = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		queue.register("cooperative-pause", async (_input, context) => {
			runs++;
				if (runs === 1) {
					await new Promise<void>((resolve) => {
						context.signal.addEventListener("abort", () => resolve(), { once: true });
					});
				await firstMayExit;
				throw new Error("first execution stopped");
			}
			return "resumed";
		});
		const job = await queue.enqueue("cooperative-pause", {});
		await waitFor(queue, job.id, ["running"]);
		await queue.pause(job.id);
		const waiting = await queue.resume(job.id);
		expect(waiting).toMatchObject({
			status: "paused",
			message: "resume requested; waiting for the current execution to stop",
			attempts: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(runs).toBe(1);
		releaseFirst();
		const completed = await waitFor(queue, job.id, ["succeeded"]);
		expect(completed).toMatchObject({ result: "resumed", attempts: 2 });
		expect(runs).toBe(2);
		await queue.stop();
	});

	it("creates a new history entry when a terminal job is retried", async () => {
		const queue = new PersistentJobQueue(":memory:");
		await queue.initialize();
		queue.register<{ value: number }, number>("identity", async (input) => input.value);
		const first = await queue.enqueue("identity", { value: 7 });
		await waitFor(queue, first.id, ["succeeded"]);
		const retried = await queue.retry(first.id, { value: 9 });
		expect(retried.id).not.toBe(first.id);
		expect((await waitFor(queue, retried.id, ["succeeded"])).result).toBe(9);
		expect(queue.get(first.id)?.result).toBe(7);
		await queue.stop();
	});

	it("restores queued and formerly running jobs after a process restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-job-restart-"));
		temporaryPaths.push(root);
		const databasePath = join(root, "jobs.sqlite");
		const firstQueue = new PersistentJobQueue(databasePath, 1);
		await firstQueue.initialize();
		const queued = await firstQueue.enqueue("restored-read", { value: 3 });
		const formerlyRunning = await firstQueue.enqueue("restored-read", { value: 4 });
		await firstQueue.stop();

		const database = new DatabaseSync(databasePath);
		database.prepare("UPDATE background_jobs SET status = 'running' WHERE id = ?").run(formerlyRunning.id);
		database.close();

		const restartedQueue = new PersistentJobQueue(databasePath, 1);
		restartedQueue.register<{ value: number }, number>("restored-read", async (input) => input.value * 2);
		await restartedQueue.initialize();
		expect((await waitFor(restartedQueue, queued.id, ["succeeded"])).result).toBe(6);
		expect((await waitFor(restartedQueue, formerlyRunning.id, ["succeeded"])).result).toBe(8);
		await restartedQueue.stop();
	});

	it("persists a signed write permit across restart and prevents replay into a new job", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-job-permit-"));
		temporaryPaths.push(root);
		const databasePath = join(root, "jobs.sqlite");
		const signingKeyPath = join(root, "operation-signing.key");
		const plan: OperationPlan = {
			kind: "personal-corpus-write",
			summary: "Persist one approved record",
			targets: [{ label: "corpus", value: join(root, "corpus"), risk: "medium" }],
			details: { recordIds: ["paper-1"] },
		};
		const firstManager = new OperationConsentManager({ signingKeyPath });
		const prepared = await firstManager.prepare(plan);
		const grant = await firstManager.confirm(prepared.operationId, prepared.manifestFingerprint, "tester");
		const executionPermit = await authorizeOperationExecution({ manager: firstManager, grant }, plan);
		const firstQueue = new PersistentJobQueue(databasePath);
		await firstQueue.initialize();
		const queued = await firstQueue.enqueue("approved-write", { executionPermit, plan, value: "saved" });
		await firstQueue.stop();

		const restartedManager = new OperationConsentManager({ signingKeyPath });
		const restartedQueue = new PersistentJobQueue(databasePath);
		restartedQueue.register<{ executionPermit: typeof executionPermit; plan: OperationPlan; value: string }, string>(
			"approved-write",
			async (input) => {
				await authorizeOperationExecution({ manager: restartedManager, permit: input.executionPermit }, input.plan);
				return input.value;
			},
		);
		await restartedQueue.initialize();
		expect((await waitFor(restartedQueue, queued.id, ["succeeded"])).result).toBe("saved");
		await expect(restartedQueue.retry(queued.id)).rejects.toThrow("already assigned to another background job");
		await restartedQueue.stop();
	});
});
