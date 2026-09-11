const INVITE_PREFIX = "pateam1.";

export interface TeamInvite {
	serverUrl: string;
	namespace: string;
	token: string;
	identity: string;
	caPem: string;
}

function validateOrigin(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!["", "/"].includes(url.pathname)
	) {
		throw new Error("Public team URL must be an HTTPS origin");
	}
	return url.origin;
}

export function encodeTeamInvite(input: TeamInvite): string {
	if (!input.token || /\s/.test(input.token)) throw new Error("Team token is invalid");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.namespace)) throw new Error("Team namespace is invalid");
	if (!input.identity.trim() || input.identity.length > 128) throw new Error("Team identity hint is invalid");
	if (!input.caPem.includes("-----BEGIN CERTIFICATE-----") || !input.caPem.includes("-----END CERTIFICATE-----")) {
		throw new Error("Team CA certificate is invalid");
	}
	const value: TeamInvite = {
		serverUrl: validateOrigin(input.serverUrl),
		namespace: input.namespace,
		token: input.token,
		identity: input.identity.trim(),
		caPem: input.caPem,
	};
	return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}
