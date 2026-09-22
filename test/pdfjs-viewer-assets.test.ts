import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const viewerRoot = resolve("web", "public", "pdfjs", "6.2.108");

describe("vendored Mozilla PDF.js viewer", () => {
	it("pins the library and generic viewer to the same release", async () => {
		const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
			dependencies: Record<string, string>;
		};
		const manifest = JSON.parse(await readFile(resolve(viewerRoot, "paper-agent-manifest.json"), "utf8")) as {
			version: string;
			license: string;
		};
		expect(packageJson.dependencies["pdfjs-dist"]).toBe("6.2.108");
		expect(manifest).toMatchObject({ version: "6.2.108", license: "Apache-2.0" });
	});

	it("ships the complete runtime entry points and supporting resources", async () => {
		await Promise.all(
			[
				"LICENSE",
				"build/pdf.mjs",
				"build/pdf.worker.mjs",
				"web/viewer.html",
				"web/viewer.css",
				"web/viewer.mjs",
				"web/locale/zh-CN/viewer.ftl",
				"web/cmaps/Adobe-GB1-UCS2.bcmap",
				"web/standard_fonts/LiberationSans-Regular.ttf",
				"web/wasm/openjpeg.wasm",
			].map((path) => access(resolve(viewerRoot, path))),
		);
	});
});
