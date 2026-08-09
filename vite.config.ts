import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	plugins: [react()],
	build: {
		outDir: "../dist/web",
		emptyOutDir: true,
		sourcemap: true,
	},
	server: {
		port: 4318,
		proxy: {
			"/api": "http://127.0.0.1:4317",
		},
	},
});
