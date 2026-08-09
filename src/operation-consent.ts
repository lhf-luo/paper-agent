import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type MutatingOperationKind =
	| "artifact-acquisition"
	| "pdf-download"
	| "personal-corpus-write"
	| "team-proposal"
	| "team-review"
	| "configuration-write"
	| "external-api-probe"
	| "research-memory-write"
	| "pdf-annotation-write"
	| "artifact-evaluation-write"
	| "team-token-management"
	| "backup-restore"
	| "file-delete"
	| "file-move";

export interface OperationTarget {
	label: string;
	value: string;
	risk?: "low" | "medium" | "high";
}

export interface OperationPlan {
	kind: MutatingOperationKind;
	summary: string;
	actor?: string;
	targets: OperationTarget[];
	details: Record<string, unknown>;
}

export interface PreparedOperation extends OperationPlan {
	operationId: string;
	manifestFingerprint: string;
	preparedAt: string;
	expiresAt: string;
}

export interface ConfirmationGrant {
	operationId: string;
	manifestFingerprint: string;
	confirmationToken: string;
	expiresAt: string;
}

export interface OperationAuthorization {
	manager: OperationConsentManager;
	grant: ConfirmationGrant;
}

/**
 * A durable proof that an exact operation plan was confirmed and its one-time
 * grant was consumed. It contains no secret token and can be persisted inside
 * a background job so the same immutable job can resume after a process
 * restart. Every execution still has to recompute and match the plan
 * fingerprint.
 */
export interface OperationExecutionPermit {
	operationId: string;
	manifestFingerprint: string;
	authorizedAt: string;
	signature: string;
}

export interface PersistedOperationAuthorization {
	manager: OperationConsentManager;
	permit: OperationExecutionPermit;
}

export type OperationExecutionAuthorization = OperationAuthorization | PersistedOperationAuthorization;

function isOperationAuthorization(value: OperationExecutionAuthorization): value is OperationAuthorization {
	return "grant" in value;
}

export async function authorizeOperationExecution(
	authorization: OperationExecutionAuthorization | undefined,
	plan: OperationPlan,
): Promise<OperationExecutionPermit> {
	if (!authorization || typeof authorization !== "object") {
		throw new Error("An exact confirmed operation authorization is required");
	}
	if (isOperationAuthorization(authorization)) {
		return authorization.manager.consumeToExecutionPermit(authorization.grant, plan);
	}
	if (!("permit" in authorization)) throw new Error("An exact confirmed operation authorization is required");
	return authorization.manager.verifyExecutionPermit(authorization.permit, plan);
}

export async function requestOperationAuthorization(
	manager: OperationConsentManager,
	plan: OperationPlan,
	confirm: (prepared: PreparedOperation) => Promise<boolean>,
	confirmedBy: string,
): Promise<OperationAuthorization> {
	const prepared = await manager.prepare(plan);
	if (!(await confirm(prepared))) {
		await manager.cancel(prepared.operationId, confirmedBy);
		throw new Error("Operation was cancelled by the user");
	}
	const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, confirmedBy);
	return { manager, grant };
}

interface StoredOperation {
	prepared: PreparedOperation;
	confirmedBy?: string;
	confirmedAt?: string;
	tokenHash?: Buffer;
	grantExpiresAt?: string;
	consumedAt?: string;
	cancelledAt?: string;
}

interface OperationConsentManagerOptions {
	auditPath?: string;
	signingKeyPath?: string;
	prepareTtlMs?: number;
	grantTtlMs?: number;
	now?: () => Date;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

export function operationFingerprint(plan: OperationPlan): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(plan)))
		.digest("hex");
}

function tokenHash(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}

export class OperationConsentManager {
	private readonly operations = new Map<string, StoredOperation>();
	private readonly auditPath?: string;
	private readonly signingKeyPath?: string;
	private readonly prepareTtlMs: number;
	private readonly grantTtlMs: number;
	private readonly now: () => Date;
	private signingKeyPromise?: Promise<Buffer>;

	constructor(options: OperationConsentManagerOptions = {}) {
		this.auditPath = options.auditPath;
		this.signingKeyPath = options.signingKeyPath;
		this.prepareTtlMs = options.prepareTtlMs ?? 15 * 60_000;
		this.grantTtlMs = options.grantTtlMs ?? 5 * 60_000;
		this.now = options.now ?? (() => new Date());
	}

	private async signingKey(): Promise<Buffer> {
		if (!this.signingKeyPromise) this.signingKeyPromise = this.loadSigningKey();
		return this.signingKeyPromise;
	}

	private async loadSigningKey(): Promise<Buffer> {
		if (!this.signingKeyPath) return randomBytes(32);
		const readExisting = async () => {
			const encoded = (await readFile(this.signingKeyPath as string, "utf8")).trim();
			const key = Buffer.from(encoded, "base64url");
			if (key.length !== 32) throw new Error("Operation signing key is invalid");
			return key;
		};
		try {
			return await readExisting();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await mkdir(dirname(this.signingKeyPath), { recursive: true });
		const key = randomBytes(32);
		try {
			await writeFile(this.signingKeyPath, key.toString("base64url"), {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			return key;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return readExisting();
		}
	}

	private async signExecutionPermit(fields: Omit<OperationExecutionPermit, "signature">): Promise<string> {
		return createHmac("sha256", await this.signingKey())
			.update(JSON.stringify(canonicalize(fields)))
			.digest("base64url");
	}

	private async audit(event: string, operation: StoredOperation, extra: Record<string, unknown> = {}): Promise<void> {
		if (!this.auditPath) return;
		await mkdir(dirname(this.auditPath), { recursive: true });
		await appendFile(
			this.auditPath,
			`${JSON.stringify({
				event,
				at: this.now().toISOString(),
				operationId: operation.prepared.operationId,
				kind: operation.prepared.kind,
				manifestFingerprint: operation.prepared.manifestFingerprint,
				actor: operation.prepared.actor,
				...extra,
			})}\n`,
			"utf8",
		);
	}

	async prepare(plan: OperationPlan): Promise<PreparedOperation> {
		if (!plan.summary.trim()) throw new Error("Operation summary is required");
		if (plan.targets.length === 0) throw new Error("At least one operation target is required");
		const preparedAt = this.now();
		const prepared: PreparedOperation = {
			...plan,
			operationId: `operation-${randomUUID()}`,
			manifestFingerprint: operationFingerprint(plan),
			preparedAt: preparedAt.toISOString(),
			expiresAt: new Date(preparedAt.getTime() + this.prepareTtlMs).toISOString(),
		};
		const stored = { prepared };
		this.operations.set(prepared.operationId, stored);
		await this.audit("prepared", stored);
		return prepared;
	}

	get(operationId: string): PreparedOperation | undefined {
		return this.operations.get(operationId)?.prepared;
	}

	async confirm(operationId: string, manifestFingerprint: string, confirmedBy: string): Promise<ConfirmationGrant> {
		const operation = this.operations.get(operationId);
		if (!operation) throw new Error("Prepared operation was not found or already expired");
		if (!confirmedBy.trim()) throw new Error("Confirmation identity is required");
		if (operation.cancelledAt) throw new Error("Prepared operation was cancelled");
		if (operation.consumedAt) throw new Error("Prepared operation was already consumed");
		if (this.now().getTime() > Date.parse(operation.prepared.expiresAt)) {
			this.operations.delete(operationId);
			throw new Error("Prepared operation expired before confirmation");
		}
		if (manifestFingerprint !== operation.prepared.manifestFingerprint) {
			throw new Error("Operation manifest changed; prepare and review it again");
		}
		const token = randomBytes(32).toString("base64url");
		const confirmedAt = this.now();
		operation.confirmedBy = confirmedBy.trim();
		operation.confirmedAt = confirmedAt.toISOString();
		operation.tokenHash = tokenHash(token);
		operation.grantExpiresAt = new Date(confirmedAt.getTime() + this.grantTtlMs).toISOString();
		await this.audit("confirmed", operation, { confirmedBy: operation.confirmedBy });
		return {
			operationId,
			manifestFingerprint,
			confirmationToken: token,
			expiresAt: operation.grantExpiresAt,
		};
	}

	async consume(grant: ConfirmationGrant, expectedPlan: OperationPlan): Promise<PreparedOperation> {
		const operation = this.operations.get(grant.operationId);
		if (!operation) throw new Error("Confirmation grant is unknown or expired");
		if (operation.cancelledAt) throw new Error("Confirmation grant belongs to a cancelled operation");
		if (operation.consumedAt) throw new Error("Confirmation grant has already been used");
		if (!operation.confirmedAt || !operation.tokenHash || !operation.grantExpiresAt) {
			throw new Error("Operation has not been confirmed by a user");
		}
		if (
			this.now().getTime() > Date.parse(operation.grantExpiresAt) ||
			this.now().getTime() > Date.parse(grant.expiresAt)
		) {
			this.operations.delete(grant.operationId);
			throw new Error("Confirmation grant expired");
		}
		const expectedFingerprint = operationFingerprint(expectedPlan);
		if (
			grant.manifestFingerprint !== operation.prepared.manifestFingerprint ||
			grant.manifestFingerprint !== expectedFingerprint
		) {
			throw new Error("Confirmed manifest does not match the operation about to execute");
		}
		const actualHash = tokenHash(grant.confirmationToken);
		if (actualHash.length !== operation.tokenHash.length || !timingSafeEqual(actualHash, operation.tokenHash)) {
			throw new Error("Confirmation token is invalid");
		}
		operation.consumedAt = this.now().toISOString();
		await this.audit("consumed", operation, { confirmedBy: operation.confirmedBy });
		return operation.prepared;
	}

	async consumeToExecutionPermit(
		grant: ConfirmationGrant,
		expectedPlan: OperationPlan,
	): Promise<OperationExecutionPermit> {
		const prepared = await this.consume(grant, expectedPlan);
		const fields = {
			operationId: prepared.operationId,
			manifestFingerprint: prepared.manifestFingerprint,
			authorizedAt: this.now().toISOString(),
		};
		return { ...fields, signature: await this.signExecutionPermit(fields) };
	}

	async verifyExecutionPermit(
		permit: OperationExecutionPermit,
		expectedPlan: OperationPlan,
	): Promise<OperationExecutionPermit> {
		if (
			!permit ||
			typeof permit !== "object" ||
			!permit.operationId?.trim() ||
			!permit.manifestFingerprint?.trim() ||
			!Number.isFinite(Date.parse(permit.authorizedAt)) ||
			!permit.signature?.trim()
		) {
			throw new Error("Persisted execution permit is invalid");
		}
		if (permit.manifestFingerprint !== operationFingerprint(expectedPlan)) {
			throw new Error("Persisted execution permit does not match the operation about to execute");
		}
		const fields = {
			operationId: permit.operationId,
			manifestFingerprint: permit.manifestFingerprint,
			authorizedAt: permit.authorizedAt,
		};
		const expectedSignature = Buffer.from(await this.signExecutionPermit(fields), "base64url");
		const actualSignature = Buffer.from(permit.signature, "base64url");
		if (
			actualSignature.length !== expectedSignature.length ||
			!timingSafeEqual(actualSignature, expectedSignature)
		) {
			throw new Error("Persisted execution permit signature is invalid");
		}
		return permit;
	}

	async cancel(operationId: string, cancelledBy = "user"): Promise<void> {
		const operation = this.operations.get(operationId);
		if (!operation || operation.consumedAt) return;
		operation.cancelledAt = this.now().toISOString();
		await this.audit("cancelled", operation, { cancelledBy });
	}

	cleanupExpired(): number {
		const now = this.now().getTime();
		let removed = 0;
		for (const [id, operation] of this.operations) {
			const expiry = operation.grantExpiresAt ?? operation.prepared.expiresAt;
			if (now <= Date.parse(expiry)) continue;
			this.operations.delete(id);
			removed++;
		}
		return removed;
	}
}
