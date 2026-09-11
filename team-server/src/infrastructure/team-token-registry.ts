import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	publicTeamIdentity, TeamIdentityError, validateIdentityName, validateTeamNamespaces, validateTeamRoles,
	type TeamIdentity, type TeamIdentitySeed, type TeamIdentityAction, type TeamIdentityInput,
} from "../domain/team-identity.ts";

export type { TeamIdentity, TeamIdentitySeed, TeamRole } from "../domain/team-identity.ts";
export interface TeamTokenRegistryFile {
	schemaVersion: 2;
	updatedAt: string;
	identities: TeamIdentity[];
}
export interface TeamTokenRegistryBackupSnapshot {
	registry: TeamTokenRegistryFile;
	auditJsonl: string;
}

export function hashTeamTokenValue(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function normalize(seed: TeamIdentitySeed): TeamIdentity {
	if (!/^[a-f0-9]{64}$/i.test(seed.tokenSha256)) throw new TeamIdentityError("Invalid team token hash");
	if (seed.id !== undefined && !/^u-[A-Za-z0-9_-]{8,64}$/.test(seed.id)) throw new TeamIdentityError("Invalid team member ID");
	const identity: TeamIdentity = {
		id: seed.id ?? `u-${randomBytes(12).toString("base64url")}`,
		name: validateIdentityName(seed.name),
		tokenSha256: seed.tokenSha256.toLowerCase(),
		roles: validateTeamRoles(seed.roles),
		namespaces: validateTeamNamespaces(seed.namespaces ?? []),
		createdAt: seed.createdAt ?? new Date().toISOString(),
	};
	for (const field of ["rotatedAt", "revokedAt", "expiresAt", "bannedAt"] as const) {
		if (seed[field] !== undefined) {
			if (!Number.isFinite(Date.parse(seed[field]!))) throw new TeamIdentityError(`Invalid ${field}`);
			identity[field] = seed[field];
		}
	}
	if (seed.banReason) identity.banReason = String(seed.banReason).slice(0, 1000);
	return identity;
}

function applyGrants(identity: TeamIdentity, input: TeamIdentityInput): void {
	if (input.roles !== undefined) identity.roles = validateTeamRoles(input.roles);
	if (input.namespaces !== undefined) identity.namespaces = validateTeamNamespaces(input.namespaces);
	if (!identity.roles.includes("admin") && !identity.namespaces.length) throw new TeamIdentityError("Ordinary members require at least one namespace");
	if (input.expiresAt === null) delete identity.expiresAt;
	else if (input.expiresAt !== undefined) {
		const time = Date.parse(input.expiresAt);
		if (!Number.isFinite(time) || time <= Date.now()) throw new TeamIdentityError("Expiry must be in the future");
		identity.expiresAt = new Date(time).toISOString();
	}
}

export class TeamTokenRegistry {
	private readonly path: string;
	private readonly auditPath: string;
	private readonly seeds: TeamIdentitySeed[];
	private state?: TeamTokenRegistryFile;
	private initializing?: Promise<void>;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(root: string, seeds: TeamIdentitySeed[], identityStorePath?: string) {
		this.path = identityStorePath ?? join(root, "_security", "identities.json");
		this.auditPath = join(dirname(this.path), "token-audit.jsonl");
		this.seeds = structuredClone(seeds);
	}

	initialize(): Promise<void> {
		this.initializing ??= this.load().catch((error) => {
			this.initializing = undefined;
			throw error;
		});
		return this.initializing;
	}

	private async load(): Promise<void> {
		let seeds = this.seeds;
		let needsWrite = true;
		let previousUpdatedAt: string | undefined;
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			if (![1, 2].includes(parsed.schemaVersion) || !Array.isArray(parsed.identities)) throw new Error("Unsupported team registry");
			seeds = parsed.identities;
			previousUpdatedAt = parsed.updatedAt;
			needsWrite = parsed.schemaVersion === 1;
			if (needsWrite) await copyFile(this.path, `${this.path}.pre-v2-${randomUUID()}.bak`);
			else if (seeds.some((seed) => !seed.id || !Array.isArray(seed.namespaces))) throw new Error("Incomplete team registry");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const identities = seeds.map(normalize);
		for (const key of ["id", "name", "tokenSha256"] as const) {
			if (new Set(identities.map((identity) => identity[key])).size !== identities.length) throw new Error(`Duplicate identity ${key}`);
		}
		const state: TeamTokenRegistryFile = { schemaVersion: 2, updatedAt: previousUpdatedAt ?? new Date().toISOString(), identities };
		if (needsWrite) await this.persist(state);
		this.state = state;
	}

	private async persist(state: TeamTokenRegistryFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, this.path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}

	private async mutate<T>(actorId: string, action: string, change: (state: TeamTokenRegistryFile) => { value: T; target: TeamIdentity }): Promise<T> {
		await this.initialize();
		const operation = this.writeChain.then(async () => {
			const next = structuredClone(this.state!);
			const actor = next.identities.find((entry) => entry.id === actorId);
			if (!actor || !actor.roles.includes("admin") || actor.revokedAt || actor.bannedAt ||
				(actor.expiresAt && Date.parse(actor.expiresAt) <= Date.now())) throw new TeamIdentityError("Active administrator required", 403);
			const { value, target } = change(next);
			next.updatedAt = new Date().toISOString();
			// Commit the candidate before making new authorization effective.
			await this.persist(next);
			this.state = next;
			await appendFile(this.auditPath, `${JSON.stringify({ id: randomUUID(), at: next.updatedAt,
				actorId: actor.id, actor: actor.name, action, targetId: target.id, target: target.name })}\n`, { mode: 0o600 });
			return value;
		});
		this.writeChain = operation.then(() => undefined, () => undefined);
		return operation;
	}

	async authenticate(token: string): Promise<TeamIdentity | undefined> {
		await this.initialize();
		const actual = Buffer.from(hashTeamTokenValue(token), "hex");
		const identity = this.state!.identities.find((entry) => !entry.revokedAt && !entry.bannedAt &&
			(!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()) && timingSafeEqual(Buffer.from(entry.tokenSha256, "hex"), actual));
		return identity ? structuredClone(identity) : undefined;
	}

	async list() {
		await this.initialize();
		return this.state!.identities.map(publicTeamIdentity);
	}

	async backupSnapshot(): Promise<TeamTokenRegistryBackupSnapshot> {
		await this.initialize();
		await this.writeChain;
		let auditJsonl = "";
		try { auditJsonl = await readFile(this.auditPath, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return { registry: structuredClone(this.state!), auditJsonl };
	}

	create(input: TeamIdentityInput, actorId: string) {
		return this.mutate(actorId, "identity.create", (state) => {
			const token = randomBytes(32).toString("base64url");
			const identity = normalize({ name: validateIdentityName(input.name), tokenSha256: hashTeamTokenValue(token),
				roles: validateTeamRoles(input.roles), namespaces: input.namespaces ?? [] });
			applyGrants(identity, input);
			if (state.identities.some((entry) => entry.name === identity.name)) throw new TeamIdentityError("Member name already exists");
			state.identities.push(identity);
			return { target: identity, value: { token, identity: publicTeamIdentity(identity) } };
		});
	}

	change(id: string, action: TeamIdentityAction, input: TeamIdentityInput, actorId: string) {
		return this.mutate(actorId, `identity.${action}`, (state) => {
			const identity = state.identities.find((entry) => entry.id === id);
			if (!identity) throw new TeamIdentityError("Team member not found", 404);
			if (id === actorId && (["revoke", "ban", "delete"].includes(action) ||
				(action === "rotate" && input.roles && !input.roles.includes("admin")))) throw new TeamIdentityError("Cannot disable the active administrator");
			let token: string | undefined;
			if (action === "rotate") {
				applyGrants(identity, input);
				token = randomBytes(32).toString("base64url");
				identity.tokenSha256 = hashTeamTokenValue(token);
				identity.rotatedAt = new Date().toISOString();
				delete identity.revokedAt;
			} else if (action === "rename") {
				const name = validateIdentityName(input.name);
				if (state.identities.some((entry) => entry.id !== id && entry.name === name)) throw new TeamIdentityError("Member name already exists");
				identity.name = name;
			} else if (action === "revoke") identity.revokedAt = new Date().toISOString();
			else if (action === "ban") { identity.bannedAt = new Date().toISOString(); identity.banReason = input.reason?.slice(0, 1000); }
			else if (action === "unban") { delete identity.bannedAt; delete identity.banReason; }
			else if (action === "delete") {
				if (!identity.revokedAt) throw new TeamIdentityError("Revoke the member before deleting it");
				state.identities = state.identities.filter((entry) => entry.id !== id);
			} else throw new TeamIdentityError("Unknown identity action");
			return { target: identity, value: { token, identity: publicTeamIdentity(identity) } };
		});
	}
}
