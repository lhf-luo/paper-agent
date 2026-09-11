import { defineConfig } from "vitest/config";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default defineConfig({
	root: import.meta.dirname,
	cacheDir: join(tmpdir(), "paper-agent-team-server-vite"),
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
