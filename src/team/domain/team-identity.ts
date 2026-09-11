export type TeamRole = "reader" | "contributor" | "reviewer" | "admin";

export interface PublicTeamIdentity {
	id: string;
	name: string;
	roles: TeamRole[];
	namespaces: string[];
	createdAt?: string;
	rotatedAt?: string;
	revokedAt?: string;
	expiresAt?: string;
	bannedAt?: string;
	banReason?: string;
}

export type TeamIdentityAction = "rotate" | "revoke" | "rename" | "ban" | "unban" | "delete";
export interface TeamIdentityInput {
	name?: string;
	roles?: TeamRole[];
	namespaces?: string[];
	expiresAt?: string | null;
	reason?: string;
}

export function canAccessTeamNamespace(
	identity: Pick<PublicTeamIdentity, "roles" | "namespaces">,
	namespace: string,
): boolean {
	return identity.roles.includes("admin") || identity.namespaces.includes(namespace);
}
