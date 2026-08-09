import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TeamRole = "reader" | "contributor" | "reviewer" | "admin";

export interface TeamIdentity {
	name: string;
	tokenSha256: string;
	roles: TeamRole[];
	createdAt?: string;
	rotatedAt?: string;
	revokedAt?: string;
}

export interface TeamTokenRegistryFile {
	schemaVersion: 1;
	updatedAt: string;
	identities: TeamIdentity[];
}

export interface TeamTokenRegistryBackupSnapshot {
	registry: TeamTokenRegistryFile;
	auditJsonl: string;
}

function hash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function validateIdentity(identity: TeamIdentity): TeamIdentity {
	if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(identity.name)) throw new Error("Team identity name is invalid");
	if (!/^[a-f0-9]{64}$/i.test(identity.tokenSha256))
		throw new Error(`Team identity ${identity.name} has an invalid token hash`);
	if (
		!identity.roles.length ||
		!identity.roles.every((role) => ["reader", "contributor", "reviewer", "admin"].includes(role))
	) {
		throw new Error(`Team identity ${identity.name} has invalid roles`);
	}
	return { ...identity, roles: [...new Set(identity.roles)] };
}

function validateRoles(roles: TeamRole[]): TeamRole[] {
	if (!roles.length || !roles.every((role) => ["reader", "contributor", "reviewer", "admin"].includes(role))) {
		throw new Error("Team identity roles are invalid");
	}
	return [...new Set(roles)];
}

export class TeamTokenRegistry {
	private readonly path: string;
	private readonly auditPath: string;
	private readonly seeds: TeamIdentity[];
	private state?: TeamTokenRegistryFile;
	private writeChain: Promise<void> = Promise.resolve();
	private auditChain: Promise<void> = Promise.resolve();

	constructor(root: string, seeds: TeamIdentity[], identityStorePath?: string) {
		this.path = identityStorePath ?? join(root, "_security", "identities.json");
		this.auditPath = join(dirname(this.path), "token-audit.jsonl");
		this.seeds = seeds.map(validateIdentity);
	}

	async initialize(): Promise<void> {
		if (this.state) return;
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as TeamTokenRegistryFile;
			if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.identities))
				throw new Error("Unsupported team identity registry");
			this.state = { ...parsed, identities: parsed.identities.map(validateIdentity) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.state = {
				schemaVersion: 1,
				updatedAt: new Date().toISOString(),
				identities: this.seeds.map((identity) => ({
					...identity,
					createdAt: identity.createdAt ?? new Date().toISOString(),
				})),
			};
			await this.persist();
		}
	}

	private async persist(): Promise<void> {
		if (!this.state) throw new Error("Team token registry is not initialized");
		this.state.updatedAt = new Date().toISOString();
		const snapshot = structuredClone(this.state);
		const write = async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				await rename(temporary, this.path);
			} catch (error) {
				try {
					await unlink(temporary);
				} catch {
					/* Preserve the write error. */
				}
				throw error;
			}
		};
		const operation = this.writeChain.then(write, write);
		this.writeChain = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
	}

	private async audit(actor: string, action: string, target: string): Promise<void> {
		const append = async () => {
			await mkdir(dirname(this.auditPath), { recursive: true });
			await appendFile(
				this.auditPath,
				`${JSON.stringify({ id: `token-event-${randomUUID()}`, at: new Date().toISOString(), actor, action, target })}\n`,
				"utf8",
			);
		};
		const operation = this.auditChain.then(append, append);
		this.auditChain = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
	}

	async authenticate(token: string): Promise<TeamIdentity | undefined> {
		await this.initialize();
		const actual = Buffer.from(hash(token), "hex");
		const identity = this.state!.identities.find((identity) => {
			if (identity.revokedAt) return false;
			const expected = Buffer.from(identity.tokenSha256, "hex");
			return expected.length === actual.length && timingSafeEqual(expected, actual);
		});
		return identity ? { ...identity, roles: [...identity.roles] } : undefined;
	}

	async list(): Promise<Array<Omit<TeamIdentity, "tokenSha256">>> {
		await this.initialize();
		return this.state!.identities.map(({ tokenSha256: _tokenSha256, ...identity }) => ({
			...identity,
			roles: [...identity.roles],
		}));
	}

	async backupSnapshot(): Promise<TeamTokenRegistryBackupSnapshot> {
		await this.initialize();
		await this.writeChain;
		await this.auditChain;
		let auditJsonl = "";
		try {
			auditJsonl = await readFile(this.auditPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return { registry: structuredClone(this.state!), auditJsonl };
	}

	async rotate(
		name: string,
		actor: string,
		roles?: TeamRole[],
	): Promise<{ token: string; identity: Omit<TeamIdentity, "tokenSha256"> }> {
		await this.initialize();
		let identity = this.state!.identities.find((candidate) => candidate.name === name);
		if (!identity) {
			if (!roles?.length) throw new Error("roles are required when creating a new team identity");
			identity = validateIdentity({ name, tokenSha256: "0".repeat(64), roles, createdAt: new Date().toISOString() });
			this.state!.identities.push(identity);
		} else if (roles?.length) {
			identity.roles = validateRoles(roles);
		}
		const token = randomBytes(32).toString("base64url");
		identity.tokenSha256 = hash(token);
		identity.rotatedAt = new Date().toISOString();
		delete identity.revokedAt;
		await this.persist();
		await this.audit(actor, "token.rotate", name);
		const { tokenSha256: _tokenSha256, ...publicIdentity } = identity;
		return { token, identity: { ...publicIdentity, roles: [...publicIdentity.roles] } };
	}

	async revoke(name: string, actor: string): Promise<Omit<TeamIdentity, "tokenSha256">> {
		await this.initialize();
		const identity = this.state!.identities.find((candidate) => candidate.name === name);
		if (!identity) throw new Error(`Team identity not found: ${name}`);
		identity.revokedAt = new Date().toISOString();
		await this.persist();
		await this.audit(actor, "token.revoke", name);
		const { tokenSha256: _tokenSha256, ...publicIdentity } = identity;
		return { ...publicIdentity, roles: [...publicIdentity.roles] };
	}
}

export function hashTeamTokenValue(token: string): string {
	return hash(token);
}
