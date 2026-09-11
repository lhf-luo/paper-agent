import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { PublicTeamIdentity, TeamRole } from "./domain/team-identity.ts";
import { encodeTeamInvite } from "./protocol/team-access.ts";

const roles = new Set<TeamRole>(["reader", "contributor", "reviewer", "admin"]);

function argument(name: string): string | undefined {
	const exact = process.argv.indexOf(`--${name}`);
	if (exact >= 0) return process.argv[exact + 1];
	return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function required(name: string): string {
	const value = argument(name);
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

async function requestJson<T>(
	origin: string,
	path: string,
	token: string,
	ca: string,
	body?: unknown,
	connectHost?: string,
): Promise<T> {
	const target = new URL(path, origin);
	if (target.protocol !== "https:") throw new Error("Team invite administration requires HTTPS");
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise<T>((resolveRequest, rejectRequest) => {
		const call = request(
			{
				protocol: target.protocol,
				hostname: connectHost ?? target.hostname,
				port: target.port || 443,
				path: `${target.pathname}${target.search}`,
				...(isIP(target.hostname) ? {} : { servername: target.hostname }),
				method: payload ? "POST" : "GET",
				ca,
				checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.hostname, certificate),
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
					host: target.host,
					...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
						rejectRequest(new Error(`Team API HTTP ${response.statusCode ?? 0}: ${text.slice(0, 500)}`));
						return;
					}
					try {
						resolveRequest(JSON.parse(text) as T);
					} catch {
						rejectRequest(new Error("Team API returned invalid JSON"));
					}
				});
			},
		);
		call.setTimeout(30_000, () => call.destroy(new Error("Team API request timed out")));
		call.on("error", rejectRequest);
		if (payload) call.write(payload);
		call.end();
	});
}

const publicUrl = argument("url") ?? process.env.PAPER_AGENT_TEAM_PUBLIC_URL;
if (!publicUrl) throw new Error("--url or PAPER_AGENT_TEAM_PUBLIC_URL is required");
const connectHost = argument("connect-host");
if (connectHost && /[\s/]/.test(connectHost)) throw new Error("--connect-host must be a hostname or IP address");
const namespace = argument("namespace") ?? "lab";
const token = (await readFile(required("token-file"), "utf8")).trim();
const caPem = await readFile(required("ca-file"), "utf8");
if (!token) throw new Error("Administrator token file is empty");

let identity: PublicTeamIdentity;
if (process.argv.includes("--existing")) {
	identity = (
		await requestJson<{ identity: PublicTeamIdentity }>(publicUrl, "/v1/whoami", token, caPem, undefined, connectHost)
	).identity;
	if (!identity.roles.includes("admin")) throw new Error("--existing requires an administrator token");
} else {
	const name = required("name");
	const selectedRoles = required("roles")
		.split(",")
		.map((value) => value.trim()) as TeamRole[];
	if (!selectedRoles.length || selectedRoles.some((role) => !roles.has(role)))
		throw new Error("--roles contains an invalid role");
	const namespaces = (argument("namespaces") ?? namespace)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const expiresDays = argument("expires-days") ? Number(argument("expires-days")) : undefined;
	if (expiresDays !== undefined && (!Number.isFinite(expiresDays) || expiresDays <= 0))
		throw new Error("--expires-days must be positive");
	const input = {
		name,
		roles: selectedRoles,
		namespaces: selectedRoles.includes("admin") ? [] : namespaces,
		...(expiresDays ? { expiresAt: new Date(Date.now() + expiresDays * 86_400_000).toISOString() } : {}),
	};
	const existing = (
		await requestJson<{ identities: PublicTeamIdentity[] }>(
			publicUrl,
			"/v1/admin/identities",
			token,
			caPem,
			undefined,
			connectHost,
		)
	).identities.find((entry) => entry.name === name);
	const result = existing
		? await requestJson<{ token: string; identity: PublicTeamIdentity }>(
				publicUrl,
				`/v1/admin/identities/${existing.id}/rotate`,
				token,
				caPem,
				input,
				connectHost,
			)
		: await requestJson<{ token: string; identity: PublicTeamIdentity }>(
				publicUrl,
				"/v1/admin/identities",
				token,
				caPem,
				input,
				connectHost,
			);
	if (!result.token) throw new Error("Team API did not return the new member token");
	identity = result.identity;
	const inviteNamespace =
		identity.roles.includes("admin") || identity.namespaces.includes(namespace) ? namespace : identity.namespaces[0];
	if (!inviteNamespace) throw new Error("The new member has no authorized namespace");
	console.log(
		encodeTeamInvite({
			serverUrl: publicUrl,
			namespace: inviteNamespace,
			token: result.token,
			identity: identity.name,
			caPem,
		}),
	);
	process.exit(0);
}

console.log(encodeTeamInvite({ serverUrl: publicUrl, namespace, token, identity: identity.name, caPem }));
