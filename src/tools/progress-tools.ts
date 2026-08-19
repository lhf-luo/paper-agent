import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface PdfCoverage {
	pageCount: number;
	pages: Set<number>;
	renderedPages: Set<number>;
	layoutPages: Set<number>;
	regionPages: Set<number>;
	tablePages: Set<number>;
	assetIndexedPages: Set<number>;
	semanticAssetIds: Set<string>;
	semanticAssetPages: Set<number>;
	verifiedAssetIds: Set<string>;
	semanticAssetPageById: Map<string, number>;
	verifiedAssetPageById: Map<string, number>;
	embeddedImageIds: Set<string>;
	truncatedAssetListings: number;
	truncatedReads: number;
}

interface ProgressDetails {
	pdfs: Array<{
		path: string;
		pageCount: number;
		readPages: number[];
		missingPages: number[];
		renderedPages: number[];
		layoutPages: number[];
		regionPages: number[];
		tablePages: number[];
		assetIndexedPages: number[];
		semanticAssetCount: number;
		semanticAssetIds: string[];
		semanticAssetPages: number[];
		verifiedAssetIds: string[];
		semanticAssets: Array<{ id: string; page: number }>;
		verifiedAssets: Array<{ id: string; page: number }>;
		embeddedImageCount: number;
		truncatedAssetListings: number;
		truncatedReads: number;
	}>;
	artifactInspections: number;
	artifactDiscoveries: number;
	artifactCandidatesDiscovered: number;
	artifactAcquisitions: number;
	artifactAcquisitionFailures: string[];
	literatureSearches: number;
	literatureCollections: number;
	literatureProviderCounts: Record<string, number>;
	literatureFailures: string[];
	fetchedSources: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numberArray(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function emptyPdfCoverage(pageCount: number): PdfCoverage {
	return {
		pageCount,
		pages: new Set<number>(),
		renderedPages: new Set<number>(),
		layoutPages: new Set<number>(),
		regionPages: new Set<number>(),
		tablePages: new Set<number>(),
		assetIndexedPages: new Set<number>(),
		semanticAssetIds: new Set<string>(),
		semanticAssetPages: new Set<number>(),
		verifiedAssetIds: new Set<string>(),
		semanticAssetPageById: new Map<string, number>(),
		verifiedAssetPageById: new Map<string, number>(),
		embeddedImageIds: new Set<string>(),
		truncatedAssetListings: 0,
		truncatedReads: 0,
	};
}

function compressPageRanges(pages: number[]): string {
	if (pages.length === 0) return "none";
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

export function registerProgressTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "paper_progress",
		label: "Paper research progress",
		description:
			"Audit the current session branch for complete PDF reading and asset-index coverage, object-level visual checks, adjacent artifacts, literature searches, and fetched primary sources. Call before drafting the final report. Truncated calls do not count as coverage.",
		promptSnippet: "Audit PDF coverage and research-source completeness",
		promptGuidelines: [
			"Call paper_progress before the final paper report and resolve every missing PDF page or explicitly disclose why it could not be read.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const pdfs = new Map<string, PdfCoverage>();
			let artifactInspections = 0;
			let artifactDiscoveries = 0;
			let artifactCandidatesDiscovered = 0;
			let artifactAcquisitions = 0;
			const artifactAcquisitionFailures: string[] = [];
			let literatureSearches = 0;
			let literatureCollections = 0;
			const literatureProviderCounts: Record<string, number> = {};
			const literatureFailures: string[] = [];
			const fetchedSources = new Set<string>();

			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
				const { details, toolName } = entry.message;
				if (!isRecord(details)) continue;

				if (toolName === "read_pdf") {
					const path = typeof details.path === "string" ? details.path : undefined;
					const pageCount = typeof details.pageCount === "number" ? details.pageCount : undefined;
					if (!path || pageCount === undefined) continue;
					const coverage = pdfs.get(path) ?? emptyPdfCoverage(pageCount);
					coverage.pageCount = Math.max(coverage.pageCount, pageCount);
					if (details.truncated === true) {
						coverage.truncatedReads++;
					} else {
						for (const page of numberArray(details.selectedPages)) coverage.pages.add(page);
					}
					pdfs.set(path, coverage);
					continue;
				}

				if (toolName === "render_pdf_page") {
					const path = typeof details.path === "string" ? details.path : undefined;
					const page = typeof details.page === "number" ? details.page : undefined;
					if (!path || page === undefined) continue;
					const coverage = pdfs.get(path) ?? emptyPdfCoverage(0);
					coverage.renderedPages.add(page);
					pdfs.set(path, coverage);
					continue;
				}

				if (
					toolName === "inspect_pdf_layout" ||
					toolName === "extract_pdf_region" ||
					toolName === "extract_pdf_table"
				) {
					const path = typeof details.path === "string" ? details.path : undefined;
					if (!path) continue;
					const pageCount = typeof details.pageCount === "number" ? details.pageCount : 0;
					const coverage = pdfs.get(path) ?? emptyPdfCoverage(pageCount);
					coverage.pageCount = Math.max(coverage.pageCount, pageCount);
					if (toolName === "inspect_pdf_layout") {
						if (details.truncated !== true) {
							for (const page of numberArray(details.selectedPages)) coverage.layoutPages.add(page);
						}
					} else {
						const page = typeof details.page === "number" ? details.page : undefined;
						if (page !== undefined) {
							if (toolName === "extract_pdf_region") coverage.regionPages.add(page);
							if (toolName === "extract_pdf_table") coverage.tablePages.add(page);
						}
						if (typeof details.assetId === "string" && page !== undefined) {
							coverage.verifiedAssetIds.add(details.assetId);
							coverage.verifiedAssetPageById.set(details.assetId, page);
						}
					}
					pdfs.set(path, coverage);
					continue;
				}

				if (toolName === "list_paper_assets") {
					const path = typeof details.path === "string" ? details.path : undefined;
					const pageCount = typeof details.pageCount === "number" ? details.pageCount : undefined;
					if (!path || pageCount === undefined) continue;
					const coverage = pdfs.get(path) ?? emptyPdfCoverage(pageCount);
					coverage.pageCount = Math.max(coverage.pageCount, pageCount);
					if (details.truncated === true) {
						coverage.truncatedAssetListings++;
					} else {
						for (const page of numberArray(details.selectedPages)) coverage.assetIndexedPages.add(page);
					}
					if (Array.isArray(details.assets)) {
						for (const asset of details.assets) {
							if (!isRecord(asset)) continue;
							if (typeof asset.id === "string") {
								coverage.semanticAssetIds.add(asset.id);
								if (typeof asset.page === "number") coverage.semanticAssetPageById.set(asset.id, asset.page);
							}
							if (typeof asset.page === "number") coverage.semanticAssetPages.add(asset.page);
						}
					}
					if (Array.isArray(details.embeddedImages)) {
						for (const image of details.embeddedImages) {
							if (!isRecord(image)) continue;
							const page = typeof image.page === "number" ? image.page : "?";
							const index = typeof image.index === "number" ? image.index : "?";
							const objectId = typeof image.objectId === "string" ? image.objectId : "?";
							const type = typeof image.type === "string" ? image.type : "?";
							coverage.embeddedImageIds.add(`${page}:${index}:${objectId}:${type}`);
						}
					}
					pdfs.set(path, coverage);
					continue;
				}

				if (toolName === "inspect_paper_artifacts") artifactInspections++;
				if (toolName === "discover_paper_artifacts") {
					artifactDiscoveries++;
					if (typeof details.candidateCount === "number") {
						artifactCandidatesDiscovered = Math.max(artifactCandidatesDiscovered, details.candidateCount);
					}
				}
				if (toolName === "acquire_paper_artifacts") {
					artifactAcquisitions++;
					if (typeof details.candidateCount === "number") {
						artifactCandidatesDiscovered = Math.max(artifactCandidatesDiscovered, details.candidateCount);
					}
					if (Array.isArray(details.failures)) {
						for (const failure of details.failures) artifactAcquisitionFailures.push(String(failure));
					}
				}
				if (toolName === "search_literature") literatureSearches++;
				if (toolName === "collect_literature") {
					literatureCollections++;
					if (isRecord(details.sourceCounts)) {
						for (const [provider, count] of Object.entries(details.sourceCounts)) {
							if (typeof count === "number") {
								literatureProviderCounts[provider] = (literatureProviderCounts[provider] ?? 0) + count;
							}
						}
					}
					if (Array.isArray(details.failures)) {
						for (const failure of details.failures) {
							if (isRecord(failure)) {
								literatureFailures.push(
									String(failure.provider ?? "provider") + ": " + String(failure.message ?? "unknown failure"),
								);
							}
						}
					}
				}
				if (toolName === "fetch_url" && typeof details.finalUrl === "string") fetchedSources.add(details.finalUrl);
			}

			const pdfDetails = [...pdfs.entries()].map(([path, coverage]) => {
				const readPages = [...coverage.pages].sort((left, right) => left - right);
				const renderedPages = [...coverage.renderedPages].sort((left, right) => left - right);
				const layoutPages = [...coverage.layoutPages].sort((left, right) => left - right);
				const regionPages = [...coverage.regionPages].sort((left, right) => left - right);
				const tablePages = [...coverage.tablePages].sort((left, right) => left - right);
				const assetIndexedPages = [...coverage.assetIndexedPages].sort((left, right) => left - right);
				const semanticAssetPages = [...coverage.semanticAssetPages].sort((left, right) => left - right);
				const missingPages = Array.from({ length: coverage.pageCount }, (_value, index) => index + 1).filter(
					(page) => !coverage.pages.has(page),
				);
				return {
					path,
					pageCount: coverage.pageCount,
					readPages,
					missingPages,
					renderedPages,
					layoutPages,
					regionPages,
					tablePages,
					assetIndexedPages,
					semanticAssetCount: coverage.semanticAssetIds.size,
					semanticAssetIds: [...coverage.semanticAssetIds].sort(),
					semanticAssetPages,
					verifiedAssetIds: [...coverage.verifiedAssetIds].sort(),
					semanticAssets: [...coverage.semanticAssetPageById.entries()]
						.map(([id, page]) => ({ id, page }))
						.sort((left, right) => left.id.localeCompare(right.id)),
					verifiedAssets: [...coverage.verifiedAssetPageById.entries()]
						.map(([id, page]) => ({ id, page }))
						.sort((left, right) => left.id.localeCompare(right.id)),
					embeddedImageCount: coverage.embeddedImageIds.size,
					truncatedAssetListings: coverage.truncatedAssetListings,
					truncatedReads: coverage.truncatedReads,
				};
			});

			const pdfText =
				pdfDetails.length === 0
					? "- No successful read_pdf calls found."
					: pdfDetails
							.map((pdf) => {
								const percentage = pdf.pageCount === 0 ? 0 : (100 * pdf.readPages.length) / pdf.pageCount;
								return [
									`- ${pdf.path}`,
									`  coverage: ${pdf.readPages.length}/${pdf.pageCount} pages (${percentage.toFixed(1)}%)`,
									`  read: ${compressPageRanges(pdf.readPages)}`,
									`  missing: ${compressPageRanges(pdf.missingPages)}`,
									`  rendered: ${compressPageRanges(pdf.renderedPages)}`,
									`  layout inspected: ${compressPageRanges(pdf.layoutPages)}`,
									`  extracted regions: ${compressPageRanges(pdf.regionPages)}`,
									`  extracted tables: ${compressPageRanges(pdf.tablePages)}`,
									`  asset index coverage: ${compressPageRanges(pdf.assetIndexedPages)}`,
									`  detected semantic assets: ${pdf.semanticAssetCount}; embedded image entries: ${pdf.embeddedImageCount}`,
									`  semantic asset pages: ${compressPageRanges(pdf.semanticAssetPages)}; verified asset ids: ${pdf.verifiedAssetIds.join(", ") || "none"}`,
									`  truncated read_pdf calls: ${pdf.truncatedReads}`,
									`  truncated list_paper_assets calls: ${pdf.truncatedAssetListings}`,
								].join("\n");
							})
							.join("\n");
			const completePdf =
				pdfDetails.length > 0 && pdfDetails.every((pdf) => pdf.pageCount > 0 && pdf.missingPages.length === 0);
			const completeAssetIndex =
				pdfDetails.length > 0 &&
				pdfDetails.every((pdf) => pdf.pageCount > 0 && pdf.assetIndexedPages.length === pdf.pageCount);
			const hasSemanticAssets = pdfDetails.some((pdf) => pdf.semanticAssetCount > 0);
			const objectLevelEvidenceChecked =
				hasSemanticAssets &&
				pdfDetails.every(
					(pdf) =>
						pdf.semanticAssetCount === 0 ||
						pdf.verifiedAssets.some((verified) =>
							pdf.semanticAssets.some(
								(semantic) => semantic.id === verified.id && semantic.page === verified.page,
							),
						),
				);
			const checklist = [
				`${completePdf ? "[x]" : "[ ]"} Every physical PDF page read without truncation`,
				`${completeAssetIndex ? "[x]" : "[ ]"} Every physical PDF page included in an untruncated asset index`,
				hasSemanticAssets
					? `${objectLevelEvidenceChecked ? "[x]" : "[ ]"} At least one indexed asset per PDF checked at object level with asset_id`
					: "[-] No captioned figure/table detected for object-level verification",
				`${artifactInspections > 0 ? "[x]" : "[ ]"} Adjacent artifacts inventoried`,
				`${artifactDiscoveries > 0 ? "[x]" : "[ ]"} PDF artifact links discovered`,
				artifactCandidatesDiscovered === 0
					? "[-] No artifact candidate discovered for acquisition"
					: `${artifactAcquisitions > 0 ? "[x]" : "[ ]"} Discovered artifacts acquired or failures recorded`,
				`${literatureSearches + literatureCollections > 0 ? "[x]" : "[ ]"} Multi-source literature discovery performed`,
				`${artifactAcquisitionFailures.length + literatureFailures.length === 0 ? "[x]" : "[ ]"} Acquisition/provider failures reviewed and disclosed`,
				`${fetchedSources.size > 0 ? "[x]" : "[ ]"} At least one public primary source fetched`,
			].join("\n");
			const text = [
				"PDF coverage:",
				pdfText,
				"",
				`Artifact inspections: ${artifactInspections}`,
				`Artifact discoveries: ${artifactDiscoveries}; candidates: ${artifactCandidatesDiscovered}; acquisition runs: ${artifactAcquisitions}`,
				`Artifact acquisition failures: ${artifactAcquisitionFailures.length}`,
				...artifactAcquisitionFailures.map((failure) => `- artifact: ${failure}`),
				`Literature searches: ${literatureSearches}`,
				`Persistent/structured collections: ${literatureCollections}`,
				`Literature provider counts: ${
					Object.entries(literatureProviderCounts)
						.map(([provider, count]) => provider + "=" + count)
						.join(", ") || "none"
				}`,
				`Literature provider failures: ${literatureFailures.length}`,
				...literatureFailures.map((failure) => `- literature: ${failure}`),
				`Fetched primary sources: ${fetchedSources.size}`,
				...[...fetchedSources].map((url) => `- ${url}`),
				"",
				"Readiness checklist:",
				checklist,
				"",
				completePdf && completeAssetIndex
					? "PDF reading and asset-index coverage are complete. Remaining unchecked research steps must be completed or disclosed before the final report."
					: "PDF research coverage is incomplete. Read every missing range and finish the asset index before drafting a paper-wide report.",
			].join("\n");
			const progressDetails: ProgressDetails = {
				pdfs: pdfDetails,
				artifactInspections,
				artifactDiscoveries,
				artifactCandidatesDiscovered,
				artifactAcquisitions,
				artifactAcquisitionFailures,
				literatureSearches,
				literatureCollections,
				literatureProviderCounts,
				literatureFailures,
				fetchedSources: [...fetchedSources],
			};
			return { content: [{ type: "text", text }], details: progressDetails };
		},
	});
}
