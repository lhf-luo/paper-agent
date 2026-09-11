import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
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
