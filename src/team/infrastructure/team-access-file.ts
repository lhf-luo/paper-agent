import { randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type TeamAccess, validateTeamAccess } from "../domain/team-access.ts";

export function teamAccessFile(projectRoot: string): string {
	return resolve(process.env.PAPER_AGENT_TEAM_ACCESS_FILE || join(projectRoot, ".paper-agent", "team-access.json"));
}

export function validateTeamCa(pem?: string): void {
	if (!pem) return;
	const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
	if (!certificates?.length) throw new Error("Invalid team CA certificate");
	try {
		for (const certificate of certificates) new X509Certificate(certificate);
	} catch {
		throw new Error("Invalid team CA certificate");
	}
}

export function readTeamAccess(projectRoot: string): TeamAccess | undefined {
	try {
		const access = validateTeamAccess(JSON.parse(readFileSync(teamAccessFile(projectRoot), "utf8")));
		validateTeamCa(access.caPem);
		return access;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Team access file is invalid; reconnect or clear local access");
	}
}

export async function saveTeamAccess(projectRoot: string, input: TeamAccess): Promise<void> {
	const access = validateTeamAccess(input);
	validateTeamCa(access.caPem);
	const path = teamAccessFile(projectRoot);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(access, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export async function clearTeamAccess(projectRoot: string): Promise<void> {
	try {
		await unlink(teamAccessFile(projectRoot));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
