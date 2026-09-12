import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeTeamBlobStream } from "../team-server/src/infrastructure/team-blob-stream.ts";
import { createTeamCorpusServer, hashTeamToken } from "../team-server/src/presentation/team-corpus-server.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

describe("team streaming and maintenance failures", () => {
	it("removes incomplete staging files after an interrupted upload or a wrong checksum", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-stream-stage-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const sha = "a".repeat(64);
		async function* broken() {
			yield Buffer.from("partial");
			throw new Error("connection interrupted");
		}
		await expect(storeTeamBlobStream(root, sha, broken(), 100)).rejects.toThrow("connection interrupted");
		await expect(storeTeamBlobStream(root, sha, Readable.from([Buffer.from("wrong")]), 100)).rejects.toMatchObject({
			status: 400,
		});
		expect(await readdir(join(root, "blobs", "sha256", "aa"))).toEqual([]);
	});

	it("bounds chunked HTTP uploads and preserves role checks on streamed downloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-stream-http-"));
		const server = createTeamCorpusServer({
			root,
			maxBlobBytes: 8,
			identities: [
				{ name: "admin", tokenSha256: hashTeamToken("fixture-stream-admin"), roles: ["admin"] },
				{
					name: "reader",
					tokenSha256: hashTeamToken("fixture-stream-reader"),
					roles: ["reader"],
					namespaces: ["lab"],
				},
			],
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		cleanups.push(async () => {
			await new Promise<void>((done) => server.close(() => done()));
			await rm(root, { recursive: true, force: true });
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		const base = `http://127.0.0.1:${address.port}/v1/namespaces/lab`;
		const upload = async (data: Buffer) => {
			const sha = createHash("sha256").update(data).digest("hex");
			const init: RequestInit & { duplex: "half" } = {
				method: "PUT",
				headers: { authorization: "Bearer fixture-stream-admin" },
				body: Readable.toWeb(Readable.from([data.subarray(0, 4), data.subarray(4)])) as unknown as BodyInit,
				duplex: "half",
			};
			return { sha, response: await fetch(`${base}/blobs/${sha}`, init) };
		};
		const tooLarge = await upload(Buffer.from("123456789"));
		expect(tooLarge.response.status).toBe(413);
		await tooLarge.response.arrayBuffer();
		const valid = await upload(Buffer.from("12345678"));
		expect(valid.response.status).toBe(200);
		await valid.response.arrayBuffer();
		const approvedRole = await fetch(`${base}/blobs/${valid.sha}`, {
			headers: { authorization: "Bearer fixture-stream-admin" },
		});
		expect(approvedRole.headers.get("content-disposition")).toContain("attachment");
		expect(await approvedRole.text()).toBe("12345678");
		const reader = await fetch(`${base}/blobs/${valid.sha}`, {
			headers: { authorization: "Bearer fixture-stream-reader" },
		});
		expect(reader.status).toBe(404);
		await reader.arrayBuffer();
	});

	it("records a failed backup for administrators without exposing maintenance paths to readers", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-backup-failure-"));
		const backupRoot = join(root, "unwritable-target");
		await writeFile(backupRoot, "not a directory");
		const server = createTeamCorpusServer({
			root: join(root, "data"),
			backupRoot,
			identities: [
				{ name: "admin", tokenSha256: hashTeamToken("fixture-backup-admin"), roles: ["admin"] },
				{
					name: "reader",
					tokenSha256: hashTeamToken("fixture-backup-reader"),
					roles: ["reader"],
					namespaces: ["lab"],
				},
			],
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		cleanups.push(async () => {
			await new Promise<void>((done) => server.close(() => done()));
			await rm(root, { recursive: true, force: true });
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		const base = `http://127.0.0.1:${address.port}/v1/namespaces/lab`;
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failed = await fetch(`${base}/backups`, {
			method: "POST",
			headers: { authorization: "Bearer fixture-backup-admin" },
		});
		expect(failed.status).toBe(500);
		await failed.arrayBuffer();
		const status = await fetch(`${base}/maintenance`, { headers: { authorization: "Bearer fixture-backup-admin" } });
		expect(await status.json()).toMatchObject({ backup: { status: "failed" } });
		const denied = await fetch(`${base}/maintenance`, { headers: { authorization: "Bearer fixture-backup-reader" } });
		expect(denied.status).toBe(403);
		await denied.arrayBuffer();
	});
});
