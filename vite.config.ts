import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	plugins: [react()],
	build: {
		outDir: "../dist/web",
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			output: {
				manualChunks(id) {
					const normalized = id.replace(/\\/g, "/");
					if (normalized.includes("/node_modules/react/") || normalized.includes("/node_modules/react-dom/")) {
						return "vendor-react";
					}
					if (normalized.includes("/node_modules/lucide-react/")) {
						return "vendor-lucide";
					}
					if (normalized.includes("/node_modules/react-markdown/") || normalized.includes("/node_modules/remark-gfm/")) {
						return "vendor-markdown";
					}
					if (normalized.includes("/node_modules/yaml/")) {
						return "vendor-yaml";
					}
				},
			},
		},
	},
	server: {
		port: 4318,
		proxy: {
			"/api": "http://127.0.0.1:4317",
		},
	},
});
