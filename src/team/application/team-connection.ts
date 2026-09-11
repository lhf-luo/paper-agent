import { createHash } from "node:crypto";
import type { ResolvedTeamAccess } from "../domain/team-access.ts";
import { readTeamAccess } from "../infrastructure/team-access-file.ts";

export function resolveTeamConnection(projectRoot: string): ResolvedTeamAccess | undefined {
	const saved = readTeamAccess(projectRoot);
	if (saved) return { ...saved, source: "access-file" };
	return undefined;
}

export function teamConnectionFingerprint(connection?: ResolvedTeamAccess): string {
	return createHash("sha256")
		.update(JSON.stringify(connection ?? null))
		.digest("hex");
}
