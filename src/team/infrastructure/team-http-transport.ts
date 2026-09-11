import { createHash } from "node:crypto";
import { Agent } from "undici";
import { validateTeamCa } from "./team-access-file.ts";

const pools = new Map<string, Agent>();

export async function teamFetch(url: URL, init: RequestInit, caCertPem?: string): Promise<Response> {
	let dispatcher: Agent | undefined;
	if (caCertPem) {
		validateTeamCa(caCertPem);
		const key = `${url.origin}:${createHash("sha256").update(caCertPem).digest("hex")}`;
		dispatcher = pools.get(key);
		if (!dispatcher) {
			dispatcher = new Agent({ connect: { ca: caCertPem }, connections: 4 });
			pools.set(key, dispatcher);
			if (pools.size > 8) {
				const oldest = pools.keys().next().value!;
				const pool = pools.get(oldest)!;
				pools.delete(oldest);
				void pool.close().catch(() => undefined);
			}
		}
	}
	// Never follow redirects carrying a bearer token, even to another path.
	return fetch(url, { ...init, redirect: "error", ...(dispatcher ? { dispatcher } : {}) });
}
