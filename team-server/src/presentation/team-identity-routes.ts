import type { IncomingMessage, ServerResponse } from "node:http";
import { type TeamIdentity, type TeamIdentityAction, type TeamIdentityInput, TeamIdentityError } from "../domain/team-identity.ts";
import type { TeamTokenRegistry } from "../infrastructure/team-token-registry.ts";
import { json, objectBody, readJsonBody, rejectForbidden } from "./team-corpus-http.ts";

export async function handleTeamIdentityRoutes(request: IncomingMessage, response: ServerResponse, pathname: string,
	identity: TeamIdentity, registry: TeamTokenRegistry, maxBytes: number): Promise<boolean> {
	if (!pathname.startsWith("/v1/admin/identities")) return false;
	if (!identity.roles.includes("admin")) rejectForbidden("admin role required");
	if (pathname === "/v1/admin/identities") {
		if (request.method === "GET") json(response, 200, { identities: await registry.list() });
		else if (request.method === "POST") {
			const input = objectBody(await readJsonBody(request, maxBytes), "Identity input must be an object");
			json(response, 201, await registry.create(input as TeamIdentityInput, identity.id));
		} else json(response, 405, { error: "method not allowed" });
		return true;
	}
	const route = /^\/v1\/admin\/identities\/(u-[A-Za-z0-9_-]+)\/(rotate|revoke|rename|ban|unban|delete)$/.exec(pathname);
	if (!route) throw new TeamIdentityError("Identity route not found", 404);
	if (request.method !== "POST") { json(response, 405, { error: "method not allowed" }); return true; }
	const input = objectBody(await readJsonBody(request, maxBytes), "Identity input must be an object");
	json(response, 200, await registry.change(route[1], route[2] as TeamIdentityAction, input as TeamIdentityInput, identity.id));
	return true;
}
