import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import type { PaperAsset } from "../src/pdf/domain/pdf-types.ts";
import type { ListPaperAssetsDetails } from "../src/pdf/presentation/pdf-asset-tool-contracts.ts";
import { registerPdfAssetsListTool } from "../src/pdf/presentation/pdf-assets-list-tool.ts";
import type { CommandExecutor } from "../src/shared/infrastructure/command-executor.ts";

const temporaryPaths: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const layout = [
	"level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
	"1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t###PAGE###",
	"3\t1\t0\t0\t0\t0\t10\t75\t80\t10\t-1\t###FLOW###",
	"4\t1\t0\t0\t0\t0\t10\t75\t80\t10\t-1\t###LINE###",
	"5\t1\t0\t0\t0\t0\t10\t75\t25\t10\t100\tFigure",
	"5\t1\t0\t0\t0\t1\t37\t75\t8\t10\t100\t1:",
	"5\t1\t0\t0\t0\t2\t47\t75\t40\t10\t100\tFixture",
].join("\n");

function fixtureExecutor(): CommandExecutor {
	const pixels = Buffer.alloc(100 * 100, 255);
	for (let y = 40; y < 85; y++) pixels.fill(0, y * 100 + 20, y * 100 + 80);
	const pgm = Buffer.concat([Buffer.from("P5\n100 100\n255\n"), pixels]);
	return {
		async exec(command, args) {
			let stdout = "";
			if (command === "pdfinfo") stdout = "Pages: 1\n";
			else if (command === "pdftotext") stdout = layout;
			else if (command === "pdftoppm") await writeFile(String(args.at(-1)) + ".pgm", pgm);
			else if (command !== "pdfimages" && command !== "tesseract") throw new Error("Unexpected command: " + command);
			return { code: 0, stdout, stderr: "", killed: false };
		},
	};
}

describe("manual PDF correction handoff", () => {
	it.each(["default", "custom"])("reuses Web corrections in the Agent index with %s storage", async (storage) => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-pdf-correction-flow-"));
		temporaryPaths.push(root);
		const config = defaultPaperAgentConfig();
		if (storage === "custom") config.storage.dataRoot = "custom-runtime";
		const saved = await savePaperAgentConfig(root, config);
		const executor = fixtureExecutor();
		const application = new PaperAgentApplication({
			projectRoot: root,
			dataRoot: saved.config.storage.dataRoot,
			executor,
		});
		const pdfPath = join(root, "papers", "original.pdf");
		await mkdir(join(root, "papers"));
		await writeFile(pdfPath, "%PDF-1.4\n% original material\n");
		const tools: Array<Parameters<ExtensionAPI["registerTool"]>[0]> = [];
		registerPdfAssetsListTool({
			exec: executor.exec,
			registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool),
		} as unknown as ExtensionAPI);
		const readAssets = async (path: string) => {
			const result = await tools[0].execute("correction-test", { path, pages: "1" }, undefined, undefined, {
				cwd: root,
			} as never);
			return { details: result.details as ListPaperAssetsDetails, content: result.content };
		};
		const analyze = async () => {
			const job = await application.enqueuePdfAnalysis({ pdfPath, refine: true, ocr: true });
			await expect.poll(() => application.jobs.get(job.id)?.status, { timeout: 10_000 }).toBe("succeeded");
			return { job, result: application.jobs.get(job.id)!.result as { assets: PaperAsset[] } };
		};
		try {
			const { job, result } = await analyze();
			expect(result.assets).toHaveLength(1);
			const correction = {
				analysisJobId: job.id,
				assetId: result.assets[0].id,
				correctedRegion: { x: 5, y: 20, width: 90, height: 70 },
				author: "researcher",
				note: "Keep the full figure and caption",
			};
			const saveCorrection = async (input: typeof correction) => {
				const prepared = await application.preparePdfAssetCorrection(input);
				const grant = await application.consent.confirm(prepared.operationId, prepared.manifestFingerprint, "test");
				return application.savePdfAssetCorrection(input, grant);
			};
			const first = await saveCorrection(correction);
			const indexed = await readAssets(pdfPath);
			expect(indexed.details.assets[0]).toMatchObject({
				candidateRegion: correction.correctedRegion,
				manualCorrection: { id: first.id, author: "researcher" },
			});
			expect(JSON.stringify(indexed.content)).toContain(first.id);

			const latestInput = { ...correction, correctedRegion: { x: 8, y: 22, width: 85, height: 66 } };
			const latest = await saveCorrection(latestInput);
			const relocatedPath = join(root, "relocated.pdf");
			await copyFile(pdfPath, relocatedPath);
			expect((await readAssets(relocatedPath)).details.assets[0]).toMatchObject({
				candidateRegion: latestInput.correctedRegion,
				manualCorrection: { id: latest.id },
			});
			expect((await analyze()).result.assets[0]).toMatchObject({
				candidateRegion: latestInput.correctedRegion,
				manualCorrection: { id: latest.id },
			});

			await writeFile(relocatedPath, "%PDF-1.4\n% different material\n");
			const different = (await readAssets(relocatedPath)).details.assets[0];
			expect(different.manualCorrection).toBeUndefined();
			expect(different.candidateRegion).not.toEqual(latestInput.correctedRegion);
		} finally {
			await application.jobs.stop();
		}
	});
});
