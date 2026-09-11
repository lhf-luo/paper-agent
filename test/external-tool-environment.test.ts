import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyExternalToolDirectories,
	resolveExternalToolDirectories,
} from "../src/shared/infrastructure/external-tool-environment.ts";

describe("external tool environment", () => {
	it("prepends configured command directories and keeps the inherited PATH", () => {
		const inherited = resolve("system-bin");
		const poppler = resolve("external", "poppler", "bin");
		const tesseract = resolve("external", "tesseract");
		const environment: NodeJS.ProcessEnv = { PATH: inherited };

		expect(applyExternalToolDirectories([poppler, tesseract], environment)).toEqual([poppler, tesseract]);
		expect(environment.PATH?.split(delimiter)).toEqual([poppler, tesseract, inherited]);
	});

	it("uses the environment override before config and replaces earlier injected directories", () => {
		const configured = resolve("configured-tools");
		const firstOverride = resolve("override-one");
		const secondOverride = resolve("override-two");
		const inherited = resolve("system-bin");
		const environment: NodeJS.ProcessEnv = {
			PATH: inherited,
			PAPER_AGENT_EXTERNAL_TOOL_PATHS: [firstOverride, secondOverride].join(delimiter),
		};

		expect(resolveExternalToolDirectories([configured], environment)).toEqual([firstOverride, secondOverride]);
		applyExternalToolDirectories([configured], environment);
		environment.PAPER_AGENT_EXTERNAL_TOOL_PATHS = secondOverride;
		applyExternalToolDirectories([configured], environment);
		expect(environment.PATH?.split(delimiter)).toEqual([secondOverride, inherited]);
	});

	it("resolves relative configured paths without requiring a fixed installation root", () => {
		const environment: NodeJS.ProcessEnv = { PATH: "" };
		expect(resolveExternalToolDirectories([join("tools", "poppler")], environment)).toEqual([
			resolve("tools", "poppler"),
		]);
	});
});
