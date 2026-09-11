import { describe, expect, it } from "vitest";
import {
	generatedGitDirectories,
	windowsUnsafeCheckoutExclusions,
	windowsUnsafeGitPaths,
} from "../src/artifacts/application/artifact-git-worktree.ts";

describe("Windows-safe Git worktrees", () => {
	it("excludes repository paths that NTFS cannot represent without renaming them", () => {
		expect(
			windowsUnsafeGitPaths([
				"src/main.c",
				"coverage/id:000002,src:000000,+cov.lcov_base",
				"fixtures/trailing. ",
				"docs/CON",
			]),
		).toEqual(["coverage/id:000002,src:000000,+cov.lcov_base", "fixtures/trailing. ", "docs/CON"]);
	});

	it("identifies conventional committed build-output directories", () => {
		expect(
			generatedGitDirectories([
				"src/main.c",
				"KLEE/klee-build/bin/klee.exe",
				"packages/app/node_modules/pkg/index.js",
				"fixtures/fuzzer-run.out/queue/id:000001",
				"docs/building.md",
			]),
		).toEqual(["KLEE/klee-build", "fixtures/fuzzer-run.out", "packages/app/node_modules"]);
	});

	it("collapses unsafe-only trees to a safely named parent directory", () => {
		expect(
			windowsUnsafeCheckoutExclusions([
				"src/main.c",
				"coverage/queue/id:000001,src:000000",
				"coverage/queue/id:000002,src:000001",
				"mixed/readme.txt",
				"mixed/id:000003,src:000002",
			]),
		).toEqual({
			directories: ["coverage"],
			files: ["mixed/id:000003,src:000002"],
		});
	});
});
