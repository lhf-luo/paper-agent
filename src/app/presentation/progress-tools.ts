import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface PdfCoverage {
	pageCount: number;
	pages: Set<number>;
	renderedPages: Set<number>;
	regionPages: Set<number>;
	tablePages: Set<number>;
	verifiedAssetIds: Set<string>;
	truncatedReads: number;
}

interface MineruCoverage {
	paperId: string;
	sourceSha256: string;
	pageCount: number;
	overview: boolean;
	sectionIds: Set<string>;
	pageRequiredBlocks: Map<number, Set<number>>;
	pageReadBlocks: Map<number, Set<number>>;
	sectionRanges: Map<string, { ids: Set<string>; ranges: Array<{ start: number; end: number; total: number }> }>;
	markdownRanges: Map<string, Array<{ start: number; end: number; total: number }>>;
	discoveredAssetIds: Set<string>;
	viewedAssetIds: Set<string>;
	truncatedCalls: number;
}

interface ProgressDetails {
	mineru: Array<{
		paperId: string;
		sourceSha256: string;
		pageCount: number;
		overview: boolean;
		sectionIds: string[];
		readPages: number[];
		missingPages: number[];
		fullMarkdownComplete: boolean;
		discoveredAssetIds: string[];
		viewedAssetIds: string[];
		truncatedCalls: number;
	}>;
	pdfs: Array<{
		path: string;
		pageCount: number;
		readPages: number[];
		renderedPages: number[];
		regionPages: number[];
		tablePages: number[];
		verifiedAssetIds: string[];
		truncatedReads: number;
	}>;
	artifactInspections: number;
	artifactDiscoveries: number;
	artifactAcquisitions: number;
	artifactAcquisitionFailures: string[];
	correlatedAssetIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numberArray(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compressPageRanges(pages: number[]): string {
	if (!pages.length) return "none";
	const ranges: string[] = [];
	let start = pages[0];
	let end = pages[0];
	for (const page of pages.slice(1)) {
		if (page === end + 1) {
			end = page;
			continue;
		}
		ranges.push(start === end ? String(start) : `${start}-${end}`);
		start = page;
		end = page;
	}
	ranges.push(start === end ? String(start) : `${start}-${end}`);
	return ranges.join(", ");
}

function rangeComplete(ranges: Array<{ start: number; end: number; total: number }>): boolean {
	if (!ranges.length) return false;
	const total = ranges[0].total;
	if (ranges.some((range) => range.total !== total)) return false;
	const sorted = [...ranges].sort((left, right) => left.start - right.start);
	let end = 0;
	for (const range of sorted) {
		if (range.start > end) return false;
		end = Math.max(end, range.end);
	}
	return end >= total;
}

function emptyPdfCoverage(pageCount: number): PdfCoverage {
	return {
		pageCount,
		pages: new Set(),
		renderedPages: new Set(),
		regionPages: new Set(),
		tablePages: new Set(),
		verifiedAssetIds: new Set(),
		truncatedReads: 0,
	};
}

function emptyMineruCoverage(paperId: string, sourceSha256: string, pageCount: number): MineruCoverage {
	return {
		paperId,
		sourceSha256,
		pageCount,
		overview: false,
		sectionIds: new Set(),
		pageRequiredBlocks: new Map(),
		pageReadBlocks: new Map(),
		sectionRanges: new Map(),
		markdownRanges: new Map(),
		discoveredAssetIds: new Set(),
		viewedAssetIds: new Set(),
		truncatedCalls: 0,
	};
}

export function registerProgressTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "paper_progress",
		label: "Paper research progress",
		description:
			"Audit MinerU reading coverage, MinerU visual inspection, targeted original-PDF verification, and optional Artifact work in the current session branch.",
		promptSnippet: "Audit MinerU coverage and targeted primary-evidence verification",
		promptGuidelines: [
			"For full-paper research, complete every MinerU page or traverse full.md until next_cursor is none.",
			"Use original PDF tools for decisive claims, critical values, quotations, equations, conflicts, and ambiguous visual crops; every PDF page need not be reread.",
			"Artifact checks are required for reproduction work, not ordinary paper reading.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const pdfs = new Map<string, PdfCoverage>();
			const mineru = new Map<string, MineruCoverage>();
			let artifactInspections = 0;
			let artifactDiscoveries = 0;
			let artifactAcquisitions = 0;
			const artifactAcquisitionFailures: string[] = [];

			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
				const { details, toolName } = entry.message;
				if (!isRecord(details)) continue;

				if (toolName === "read_mineru_material" && isRecord(details.material)) {
					const paperId = typeof details.material.paperId === "string" ? details.material.paperId : undefined;
					const sourceSha256 =
						typeof details.material.sourceSha256 === "string" ? details.material.sourceSha256 : undefined;
					const pageCount = typeof details.material.pageCount === "number" ? details.material.pageCount : 0;
					if (!paperId || !sourceSha256) continue;
					const key = `${paperId}\0${sourceSha256}`;
					const coverage = mineru.get(key) ?? emptyMineruCoverage(paperId, sourceSha256, pageCount);
					coverage.pageCount = Math.max(coverage.pageCount, pageCount);
					if (details.mode === "overview") coverage.overview = true;
					if (details.truncated === true) coverage.truncatedCalls++;
					const selectedSectionIds = stringArray(details.selectedSectionIds);
					if (Array.isArray(details.pageBlocks)) {
						for (const item of details.pageBlocks) {
							if (!isRecord(item) || typeof item.page !== "number") continue;
							const required = coverage.pageRequiredBlocks.get(item.page) ?? new Set<number>();
							const read = coverage.pageReadBlocks.get(item.page) ?? new Set<number>();
							for (const block of numberArray(item.total)) required.add(block);
							for (const block of numberArray(item.selected)) read.add(block);
							coverage.pageRequiredBlocks.set(item.page, required);
							coverage.pageReadBlocks.set(item.page, read);
						}
					}
					if (details.mode === "markdown" && isRecord(details.cursorRange)) {
						const { start, end, total, key: cursorKey } = details.cursorRange;
						if (
							typeof start === "number" &&
							typeof end === "number" &&
							typeof total === "number" &&
							typeof cursorKey === "string"
						) {
							const ranges = coverage.markdownRanges.get(cursorKey) ?? [];
							ranges.push({ start, end, total });
							coverage.markdownRanges.set(cursorKey, ranges);
						}
					}
					if (details.mode === "sections" && isRecord(details.cursorRange)) {
						const { start, end, total, key: cursorKey } = details.cursorRange;
						if (
							typeof start === "number" &&
							typeof end === "number" &&
							typeof total === "number" &&
							typeof cursorKey === "string"
						) {
							const entry = coverage.sectionRanges.get(cursorKey) ?? { ids: new Set<string>(), ranges: [] };
							for (const id of selectedSectionIds) entry.ids.add(id);
							entry.ranges.push({ start, end, total });
							coverage.sectionRanges.set(cursorKey, entry);
						}
					}
					if (
						details.mode === "overview" &&
						isRecord(details.manifest) &&
						Array.isArray(details.manifest.assets)
					) {
						for (const asset of details.manifest.assets) {
							if (isRecord(asset) && typeof asset.id === "string") coverage.discoveredAssetIds.add(asset.id);
						}
					}
					if (Array.isArray(details.assetResults)) {
						for (const asset of details.assetResults) {
							if (isRecord(asset) && typeof asset.id === "string") coverage.viewedAssetIds.add(asset.id);
						}
					}
					mineru.set(key, coverage);
					continue;
				}

				if (toolName === "read_pdf") {
					const path = typeof details.path === "string" ? details.path : undefined;
					const pageCount = typeof details.pageCount === "number" ? details.pageCount : undefined;
					if (!path || pageCount === undefined) continue;
					const coverage = pdfs.get(path) ?? emptyPdfCoverage(pageCount);
					coverage.pageCount = Math.max(coverage.pageCount, pageCount);
					if (details.truncated === true) coverage.truncatedReads++;
					else for (const page of numberArray(details.selectedPages)) coverage.pages.add(page);
					pdfs.set(path, coverage);
					continue;
				}

				if (
					toolName === "render_pdf_page" ||
					toolName === "extract_pdf_region" ||
					toolName === "extract_pdf_table"
				) {
					const path = typeof details.path === "string" ? details.path : undefined;
					const page = typeof details.page === "number" ? details.page : undefined;
					if (!path || page === undefined) continue;
					const coverage = pdfs.get(path) ?? emptyPdfCoverage(Number(details.pageCount ?? 0));
					if (toolName === "render_pdf_page") coverage.renderedPages.add(page);
					if (toolName === "extract_pdf_region") coverage.regionPages.add(page);
					if (toolName === "extract_pdf_table") coverage.tablePages.add(page);
					if (typeof details.assetId === "string") coverage.verifiedAssetIds.add(details.assetId);
					pdfs.set(path, coverage);
					continue;
				}

				if (toolName === "inspect_paper_artifacts") artifactInspections++;
				if (toolName === "discover_paper_artifacts") artifactDiscoveries++;
				if (toolName === "acquire_paper_artifacts") {
					artifactAcquisitions++;
					if (Array.isArray(details.failures)) {
						for (const failure of details.failures) artifactAcquisitionFailures.push(String(failure));
					}
				}
			}

			const mineruDetails = [...mineru.values()].map((coverage) => {
				for (const entry of coverage.sectionRanges.values()) {
					if (rangeComplete(entry.ranges)) for (const id of entry.ids) coverage.sectionIds.add(id);
				}
				const readPages = [...coverage.pageRequiredBlocks.entries()]
					.filter(([page, required]) => {
						const read = coverage.pageReadBlocks.get(page) ?? new Set<number>();
						return required.size > 0 && [...required].every((block) => read.has(block));
					})
					.map(([page]) => page)
					.sort((left, right) => left - right);
				const missingPages = Array.from({ length: coverage.pageCount }, (_value, index) => index + 1).filter(
					(page) => !readPages.includes(page),
				);
				return {
					paperId: coverage.paperId,
					sourceSha256: coverage.sourceSha256,
					pageCount: coverage.pageCount,
					overview: coverage.overview,
					sectionIds: [...coverage.sectionIds].sort(),
					readPages,
					missingPages,
					fullMarkdownComplete: [...coverage.markdownRanges.values()].some(rangeComplete),
					discoveredAssetIds: [...coverage.discoveredAssetIds].sort(),
					viewedAssetIds: [...coverage.viewedAssetIds].sort(),
					truncatedCalls: coverage.truncatedCalls,
				};
			});
			const pdfDetails = [...pdfs.entries()].map(([path, coverage]) => ({
				path,
				pageCount: coverage.pageCount,
				readPages: [...coverage.pages].sort((left, right) => left - right),
				renderedPages: [...coverage.renderedPages].sort((left, right) => left - right),
				regionPages: [...coverage.regionPages].sort((left, right) => left - right),
				tablePages: [...coverage.tablePages].sort((left, right) => left - right),
				verifiedAssetIds: [...coverage.verifiedAssetIds].sort(),
				truncatedReads: coverage.truncatedReads,
			}));
			const mineruAssetIds = new Set(mineruDetails.flatMap((item) => item.discoveredAssetIds));
			const correlatedAssetIds = [
				...new Set(pdfDetails.flatMap((item) => item.verifiedAssetIds).filter((id) => mineruAssetIds.has(id))),
			].sort();

			const mineruText = mineruDetails.length
				? mineruDetails
						.map((item) => {
							const complete =
								item.fullMarkdownComplete || (item.pageCount > 0 && item.missingPages.length === 0);
							return [
								`- ${item.paperId} @ ${item.sourceSha256}`,
								`  current material: yes; overview: ${item.overview ? "yes" : "no"}`,
								`  sections read: ${item.sectionIds.join(", ") || "none"}`,
								`  complete pages: ${compressPageRanges(item.readPages)}`,
								`  missing pages: ${compressPageRanges(item.missingPages)}`,
								`  full.md traversal: ${item.fullMarkdownComplete ? "complete" : "incomplete"}`,
								`  full-paper MinerU coverage: ${complete ? "complete" : "incomplete"}`,
								`  visual assets discovered/viewed: ${item.discoveredAssetIds.length}/${item.viewedAssetIds.length}`,
								`  truncated calls: ${item.truncatedCalls}`,
							].join("\n");
						})
						.join("\n")
				: "- No successful read_mineru_material calls found.";
			const pdfText = pdfDetails.length
				? pdfDetails
						.map((item) =>
							[
								`- ${item.path}`,
								`  text pages: ${compressPageRanges(item.readPages)}`,
								`  rendered pages: ${compressPageRanges(item.renderedPages)}`,
								`  extracted regions: ${compressPageRanges(item.regionPages)}`,
								`  extracted tables: ${compressPageRanges(item.tablePages)}`,
								`  verified asset IDs: ${item.verifiedAssetIds.join(", ") || "none"}`,
								`  truncated reads: ${item.truncatedReads}`,
							].join("\n"),
						)
						.join("\n")
				: "- No targeted original-PDF verification found.";
			const text = [
				"MinerU reading:",
				mineruText,
				"",
				"Original PDF verification:",
				pdfText,
				`MinerU/PDF asset ID correlations: ${correlatedAssetIds.join(", ") || "none"}`,
				"",
				"Artifact/reproduction:",
				`- discoveries: ${artifactDiscoveries}`,
				`- acquisitions: ${artifactAcquisitions}`,
				`- inspections: ${artifactInspections}`,
				`- acquisition failures: ${artifactAcquisitionFailures.length}`,
				...artifactAcquisitionFailures.map((failure) => `  - ${failure}`),
			].join("\n");
			const progressDetails: ProgressDetails = {
				mineru: mineruDetails,
				pdfs: pdfDetails,
				artifactInspections,
				artifactDiscoveries,
				artifactAcquisitions,
				artifactAcquisitionFailures,
				correlatedAssetIds,
			};
			return { content: [{ type: "text", text }], details: progressDetails };
		},
	});
}
