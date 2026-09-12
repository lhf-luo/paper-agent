export type TeamRole = "reader" | "contributor" | "reviewer" | "admin";

export interface TeamIdentity {
	id: string;
	name: string;
	tokenSha256: string;
	roles: TeamRole[];
	namespaces: string[];
	createdAt?: string;
	rotatedAt?: string;
	revokedAt?: string;
	expiresAt?: string;
	bannedAt?: string;
	banReason?: string;
}

export type TeamIdentitySeed = Omit<TeamIdentity, "id" | "namespaces"> & { id?: string; namespaces?: string[] };
export type PublicTeamIdentity = Omit<TeamIdentity, "tokenSha256">;
export type TeamIdentityAction = "rotate" | "revoke" | "rename" | "ban" | "unban" | "delete";
export interface TeamIdentityInput {
	name?: string;
	roles?: TeamRole[];
	namespaces?: string[];
	expiresAt?: string | null;
	reason?: string;
}

export class TeamIdentityError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export function validateIdentityName(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TeamIdentityError("Invalid team member name");
	}
	return value.trim();
}

export function validateTeamRoles(value: unknown): TeamRole[] {
	if (!Array.isArray(value) || !value.length || !value.every((role) => ["reader", "contributor", "reviewer", "admin"].includes(role))) {
		throw new TeamIdentityError("At least one valid team role is required");
	}
	return [...new Set(value)] as TeamRole[];
}

export function validateTeamNamespaces(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))) {
		throw new TeamIdentityError("Invalid team namespaces");
	}
	return [...new Set(value)];
}

export function canAccessTeamNamespace(identity: Pick<TeamIdentity, "roles" | "namespaces">, namespace: string): boolean {
	return identity.roles.includes("admin") || identity.namespaces.includes(namespace);
}

export function publicTeamIdentity(identity: TeamIdentity): PublicTeamIdentity {
	const { tokenSha256: _hash, ...publicIdentity } = identity;
	return structuredClone(publicIdentity);
}
