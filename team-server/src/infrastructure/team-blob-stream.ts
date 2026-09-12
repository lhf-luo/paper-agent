import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TeamStateError } from "../domain/team-state-error.ts";

/** Content is staged on disk and hashed incrementally; incomplete uploads never acquire a content address. */
export async function storeTeamBlobStream(
	root: string,
	sha256: string,
	source: AsyncIterable<Uint8Array>,
	maxBytes: number,
) {
	if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TeamStateError(400, "Invalid blob hash");
	const directory = join(root, "blobs", "sha256", sha256.slice(0, 2));
	await mkdir(directory, { recursive: true });
	const path = join(directory, sha256);
	const temporary = join(directory, `${sha256}.${randomUUID()}.tmp`);
	const hash = createHash("sha256");
	let bytes = 0;
	const handle = await open(temporary, "wx", 0o600);
	try {
		for await (const chunk of source) {
			bytes += chunk.byteLength;
			if (bytes > maxBytes) throw new TeamStateError(413, "Blob exceeds configured size limit");
			hash.update(chunk);
			await handle.writeFile(chunk);
		}
		if (hash.digest("hex") !== sha256)
			throw new TeamStateError(400, "Uploaded blob SHA-256 does not match the request path");
		await handle.sync();
		await handle.close();
		const existed = await stat(path).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		);
		if (!existed) await rename(temporary, path);
		return { sha256, path, bytes, existed };
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
