import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		// Native subprocess fixtures and durable file writes should not oversubscribe Windows hosts.
		maxWorkers: process.platform === "win32" ? Math.min(4, availableParallelism()) : undefined,
		reporters: "dot",
		// The team service writes a JSON access log per request; keep test output readable.
		env: { PAPER_AGENT_TEAM_ACCESS_LOG: "off" },
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
});
