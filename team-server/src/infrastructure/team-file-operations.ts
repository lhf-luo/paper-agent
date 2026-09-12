import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Windows scanners may briefly deny replacement. Retry the atomic operation, never delete its destination. */
export async function renameTeamFile(source: string, target: string): Promise<void> {
	const deadline = Date.now() + 2000;
	let pause = 10;
	for (;;) {
		try {
			await rename(source, target);
			return;
		} catch (error) {
			if (
				process.platform !== "win32" ||
				!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") ||
				Date.now() >= deadline
			)
				throw error;
			await delay(pause);
			pause = Math.min(pause * 2, 100);
		}
	}
}
