import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	authorizeOperationExecution,
	OperationConsentManager,
	type OperationPlan,
} from "../src/operation-consent.ts";

const plan: OperationPlan = {
	kind: "artifact-acquisition",
	summary: "Acquire one repository",
	targets: [{ label: "repository", value: "https://github.com/example/project", risk: "medium" }],
	details: { candidateIds: ["artifact-1"], maxArtifacts: 1 },
};

describe("OperationConsentManager", () => {
	it("binds a one-time confirmation token to the exact reviewed manifest", async () => {
		const manager = new OperationConsentManager();
		const prepared = await manager.prepare(plan);
		const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "tester");

		await expect(manager.consume(grant, plan)).resolves.toMatchObject({ operationId: prepared.operationId });
		await expect(manager.consume(grant, plan)).rejects.toThrow("already been used");
	});

	it("converts a one-time grant into a durable, non-secret permit for the same background job", async () => {
		const manager = new OperationConsentManager();
		const prepared = await manager.prepare(plan);
		const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "tester");
		const permit = await authorizeOperationExecution({ manager, grant }, plan);
		const restoredPermit = JSON.parse(JSON.stringify(permit));

		await expect(authorizeOperationExecution({ manager, permit: restoredPermit }, plan)).resolves.toEqual(permit);
		await expect(
			authorizeOperationExecution(
				{ manager, permit: restoredPermit },
				{ ...plan, details: { candidateIds: ["artifact-2"] } },
			),
		).rejects.toThrow("does not match");
		expect(JSON.stringify(permit)).not.toContain(grant.confirmationToken);
		await expect(authorizeOperationExecution({ manager, grant }, plan)).rejects.toThrow("already been used");
	});

	it("rejects forged durable permits and verifies signed permits after a manager restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-consent-key-"));
		const signingKeyPath = join(root, "operation-signing.key");
		const firstManager = new OperationConsentManager({ signingKeyPath });
		const prepared = await firstManager.prepare(plan);
		const grant = await firstManager.confirm(prepared.operationId, prepared.manifestFingerprint, "tester");
		const permit = await authorizeOperationExecution({ manager: firstManager, grant }, plan);
		const restartedManager = new OperationConsentManager({ signingKeyPath });

		await expect(authorizeOperationExecution({ manager: restartedManager, permit }, plan)).resolves.toEqual(permit);
		await expect(
			authorizeOperationExecution(
				{ manager: restartedManager, permit: { ...permit, operationId: "operation-forged" } },
				plan,
			),
		).rejects.toThrow("signature is invalid");
	});

	it("reports a clear authorization error when a write path receives no permit", async () => {
		await expect(authorizeOperationExecution(undefined, plan)).rejects.toThrow(
			"exact confirmed operation authorization is required",
		);
	});

	it("rejects changed plans, invalid tokens, and expired grants", async () => {
		let time = Date.parse("2026-01-01T00:00:00.000Z");
		const manager = new OperationConsentManager({
			now: () => new Date(time),
			prepareTtlMs: 1_000,
			grantTtlMs: 500,
		});
		const prepared = await manager.prepare(plan);
		const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "tester");
		await expect(manager.consume({ ...grant, confirmationToken: "wrong" }, plan)).rejects.toThrow("invalid");
		await expect(manager.consume(grant, { ...plan, details: { maxArtifacts: 2 } })).rejects.toThrow("does not match");
		time += 501;
		await expect(manager.consume(grant, plan)).rejects.toThrow("expired");
	});

	it("writes append-only audit events without the secret token", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-consent-"));
		const auditPath = join(root, "audit.jsonl");
		const manager = new OperationConsentManager({ auditPath });
		const prepared = await manager.prepare(plan);
		const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "tester");
		await manager.consume(grant, plan);
		const audit = await readFile(auditPath, "utf8");

		expect(audit).toContain('"event":"prepared"');
		expect(audit).toContain('"event":"confirmed"');
		expect(audit).toContain('"event":"consumed"');
		expect(audit).not.toContain(grant.confirmationToken);
	});
});
