import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type VerifyMode = "quick" | "full" | "live";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const modeArgument = process.argv.find((argument) => argument === "--mode");
const requestedMode = modeArgument ? process.argv[process.argv.indexOf(modeArgument) + 1] : "quick";
const mode = (requestedMode ?? "quick").toLowerCase() as VerifyMode;
if (!["quick", "full", "live"].includes(mode)) {
	throw new Error(`Unknown verification mode: ${requestedMode}. Use quick, full, or live.`);
}

function runNode(label: string, script: string, args: string[] = []): void {
	console.log(`\n[verify] ${label}`);
	const result = spawnSync(node, [join(projectRoot, script), ...args], {
		cwd: projectRoot,
		stdio: "inherit",
		windowsHide: true,
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
}

function runBinary(label: string, binary: string, args: string[] = []): void {
	runNode(label, binary, args);
}

console.log(`Paper Agent verification (${mode})`);
runBinary("Biome lint", "node_modules/@biomejs/biome/bin/biome", ["lint", "."]);
runBinary("TypeScript typecheck", "node_modules/typescript/bin/tsc", ["--noEmit"]);
runBinary("Web TypeScript typecheck", "node_modules/typescript/bin/tsc", ["-p", "web/tsconfig.json"]);
runBinary("Web production build", "node_modules/vite/bin/vite.js", ["build"]);
runBinary("Vitest suite", "node_modules/vitest/vitest.mjs", ["run"]);
runNode("CLI and local Web smoke", "scripts/cli-smoke.ts");
runNode("Team service, backup, and restore smoke", "scripts/team-corpus-smoke.ts");

if (mode === "full" || mode === "live") {
	// This report is deliberately informational until an independently human-reviewed
	// artifact gold set exists; the command must not turn an empty gold set into a
	// false release claim.
	runNode("Artifact discovery evaluation (informational)", "scripts/evaluate-artifact-discovery.ts", [
		"eval-data/artifacts",
	]);
	runNode("Pinned real-PDF release gate", "scripts/fetch-pdf-asset-eval-set.ts", ["eval-data/annotations"]);
	runNode("Pinned real-PDF metrics", "scripts/evaluate-pdf-assets.ts", ["eval-data/annotations", "--check"]);
}

if (mode === "live") {
	runNode("Live provider and public-Git smoke", "scripts/live-integration-smoke.ts");
}

console.log(`\nAll selected ${mode} verification checks passed.`);
