import { validateTeamNamespace } from "../domain/team-corpus-validation.ts";

const INVITE_PREFIX = "pateam1.";

export interface TeamAccess {
	serverUrl: string;
	namespace: string;
	token: string;
	identity?: string;
	caPem?: string;
}
export type TeamConnectionSource = "access-file";
export interface ResolvedTeamAccess extends TeamAccess {
	source: TeamConnectionSource;
}

export function validateTeamServerUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Invalid team server URL");
	}
	if (
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "")
	) {
		throw new Error("Team server must be an HTTPS origin (HTTP is allowed only on loopback)");
	}
	return url.origin;
}

export function validateTeamAccess(input: unknown): TeamAccess {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid team access data");
	const value = input as Record<string, unknown>;
	if (
		typeof value.serverUrl !== "string" ||
		typeof value.namespace !== "string" ||
		typeof value.token !== "string" ||
		!value.token ||
		value.token.length > 4096 ||
		/\s/.test(value.token)
	)
		throw new Error("Invalid team access fields");
	if (
		value.identity !== undefined &&
		(typeof value.identity !== "string" || !value.identity.trim() || value.identity.length > 128)
	) {
		throw new Error("Invalid team identity hint");
	}
	if (value.caPem !== undefined && (typeof value.caPem !== "string" || value.caPem.length > 48_000))
		throw new Error("Invalid team CA certificate");
	const serverUrl = validateTeamServerUrl(value.serverUrl);
	if (new URL(serverUrl).protocol === "https:" && typeof value.caPem !== "string") {
		throw new Error("Remote team access must include its CA certificate");
	}
	return {
		serverUrl,
		namespace: validateTeamNamespace(value.namespace),
		token: value.token,
		identity: typeof value.identity === "string" ? value.identity.trim() : undefined,
		caPem: value.caPem as string | undefined,
	};
}

export function decodeTeamInvite(value: string): TeamAccess {
	const normalized = typeof value === "string" ? value.replace(/\s+/g, "") : "";
	const pattern = new RegExp(`^${INVITE_PREFIX.replace(/\./g, "\\.")}[A-Za-z0-9_-]+$`);
	if (normalized.length > 90_000 || !pattern.test(normalized)) throw new Error("Invalid team invite");
	try {
		const payload = Buffer.from(normalized.slice(INVITE_PREFIX.length), "base64url").toString("utf8");
		return validateTeamAccess(JSON.parse(payload));
	} catch {
		throw new Error("Invalid team invite content");
	}
}

export function encodeTeamInvite(value: TeamAccess): string {
	return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(validateTeamAccess(value))).toString("base64url")}`;
}
