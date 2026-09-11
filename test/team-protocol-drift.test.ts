import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Protocol files are duplicated between the client (`src/`) and the standalone service (`team-server/`).
 * They must stay line-identical; only `import` lines may differ, because the relative paths necessarily do.
 */
function normalizeProtocolSource(source: string): string {
	return source
		.replace(/\r\n/g, "\n")
		.split("\n")
		.filter((line) => !line.startsWith("import"))
		.join("\n")
		.trim();
}

const protocolPairs: Array<[string, string]> = [
	["src/literature/domain/literature-types.ts", "team-server/src/protocol/literature-types.ts"],
	["src/team/domain/team-corpus-types.ts", "team-server/src/protocol/team-corpus-types.ts"],
	["src/team/domain/team-access.ts", "team-server/src/protocol/team-access.ts"],
	["src/team/domain/team-identity.ts", "team-server/src/protocol/team-identity.ts"],
];

describe("team protocol single source of truth", () => {
	for (const [clientPath, serverPath] of protocolPairs) {
		it(`keeps ${clientPath} and ${serverPath} identical apart from imports`, () => {
			const client = normalizeProtocolSource(readFileSync(join(projectRoot, clientPath), "utf8"));
			const server = normalizeProtocolSource(readFileSync(join(projectRoot, serverPath), "utf8"));
			if (client !== server) {
				const clientLines = client.split("\n");
				const serverLines = server.split("\n");
				const differences: string[] = [];
				for (let index = 0; index < Math.max(clientLines.length, serverLines.length); index++) {
					if (clientLines[index] !== serverLines[index]) {
						differences.push(
							`L${index + 1}\n  client: ${JSON.stringify(clientLines[index] ?? null)}\n  server: ${JSON.stringify(serverLines[index] ?? null)}`,
						);
					}
				}
				throw new Error(`Protocol copies drifted:\n${differences.join("\n")}`);
			}
			expect(client).toBe(server);
		});
	}

	it("keeps the server identity domain a thin re-export of the protocol copy", () => {
		const domain = readFileSync(join(projectRoot, "team-server/src/domain/team-identity.ts"), "utf8");
		expect(domain).toContain('export * from "../protocol/team-identity.ts"');
	});
});
