import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectLiterature } from "./collection-tools.ts";
import type { PaperRecord } from "./literature-types.ts";
import { requestInteractiveOperationAuthorization } from "./interactive-operation-consent.ts";
import { ResearchWorkspace, validateResearchRecord, type SourceLocator } from "./research-workspace.ts";
import type { OperationPlan } from "./operation-consent.ts";
import { runAuthorizedMutation } from "./literature-write.ts";
import { fetchPublicUrl, htmlToText, readResponseBody } from "./network-security.ts";

interface SearchDetails {
	query: string;
	resultCount: number;
	errors: string[];
	sourceCounts: Record<string, number>;
}

interface FetchDetails {
	requestedUrl: string;
	finalUrl: string;
	contentType: string;
	downloadedPdfPath?: string;
	truncated: boolean;
}

function formatResult(result: PaperRecord, index: number): string {
	const fields = [
		String(index + 1) +
			". [" +
			[...new Set(result.provenance.map((item) => item.provider))].join("+") +
			"] " +
			result.title,
		"   Authors: " +
			(result.authors.slice(0, 12).join(", ") || "unavailable") +
			(result.authors.length > 12 ? ", et al." : ""),
		"   Year: " + (result.year ?? "unavailable"),
		"   URL: " + (result.links[0]?.url ?? "unavailable"),
	];
	if (result.identifiers.doi) fields.push("   DOI: " + result.identifiers.doi);
	if (result.citationCount !== undefined) fields.push("   cited_by_count: " + result.citationCount);
	if (result.abstract) fields.push("   Abstract: " + result.abstract.slice(0, 1_200));
	return fields.join("\n");
}

export function registerResearchTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "save_skim_card",
		label: "Save skim card",
		description:
			"Persist a structured skim card (five-question summary of a paper) into the personal research workspace. Records paperId, problem, method, findings, limitations, and source locators. Use after reading a paper with read_pdf/list_paper_assets.",
		promptSnippet: "Save a skim card for a paper into the research workspace",
		promptGuidelines: [
			"Every finding must carry a source locator (page/section/quote) from the paper.",
			"The card is AI-assisted: a human must review it before it counts as reviewed.",
		],
		parameters: Type.Object({
			paperId: Type.String({ minLength: 1, maxLength: 128 }),
			title: Type.String({ minLength: 1, maxLength: 300 }),
			researchQuestion: Type.String({ minLength: 1, maxLength: 20_000 }),
			problem: Type.String({ minLength: 1, maxLength: 20_000 }),
			method: Type.String({ minLength: 1, maxLength: 20_000 }),
			datasets: Type.String({ minLength: 1, maxLength: 20_000 }),
			findings: Type.String({ minLength: 1, maxLength: 20_000 }),
			limitations: Type.String({ minLength: 1, maxLength: 20_000 }),
			unknowns: Type.String({ minLength: 1, maxLength: 20_000 }),
			sources: Type.Array(
				Type.Object({
					paperId: Type.Optional(Type.String({ maxLength: 128 })),
					page: Type.Optional(Type.Integer({ minimum: 1 })),
				section: Type.Optional(Type.String({ maxLength: 200 })),
				quote: Type.Optional(Type.String({ maxLength: 10_000 })),
				url: Type.Optional(Type.String({ maxLength: 2_000 })),
			}),
		),
			model: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const now = new Date().toISOString();
			const author = params.model ? "paper-agent" : "human";
			const record = validateResearchRecord(
				{
					id: `skim-card-${randomUUID()}`,
					kind: "skim-card",
					title: params.title,
					authorship: {
						type: params.model ? "ai-assisted" : "human",
						author,
						...(params.model ? { model: params.model } : {}),
						humanReviewed: false,
					},
					createdAt: now,
					updatedAt: now,
					revision: 0,
					paperId: params.paperId,
					researchQuestion: params.researchQuestion,
					problem: params.problem,
					method: params.method,
					datasets: params.datasets,
					findings: params.findings,
					limitations: params.limitations,
					unknowns: params.unknowns,
					sources: params.sources as SourceLocator[],
				},
			);
			const plan: OperationPlan = {
				kind: "research-memory-write",
				summary: `Save skim card for ${params.paperId}`,
				targets: [{ label: "research", value: join(ctx.cwd, ".paper-agent", "research"), risk: "low" }],
				details: { recordKind: "skim-card", paperId: params.paperId },
			};
			const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
				title: "保存略读卡到研究工作区？",
				unavailableMessage: "保存略读卡需要交互确认, 请使用 Web 界面。",
				details: () => [
					`论文: ${params.paperId}`,
					`标题: ${params.title.slice(0, 80)}`,
					`来源定位: ${params.sources.length} 条`,
					`作者: ${author}${params.model ? ` (${params.model})` : ""}, 未人工复核`,
				],
			});
			await authorization.manager.consume(authorization.grant, plan);
			const workspace = new ResearchWorkspace(join(ctx.cwd, ".paper-agent", "research", "default"));
			await workspace.initialize();
			await workspace.save(record);
			return {
				content: [{ type: "text", text: `略读卡已保存: ${record.id} (未人工复核)` }],
				details: { recordId: record.id, kind: "skim-card", paperId: params.paperId, saved: true },
			};
		},
	});
	pi.registerTool({
		name: "search_literature",
		label: "Search literature",
		description:
			"Compatibility search across arXiv, OpenAlex, and Crossref with DOI/arXiv/title deduplication and partial-source failure reporting. For pagination, filters, query variants, caching, or persistence use collect_literature.",
		promptSnippet: "Quickly search three literature metadata providers",
		promptGuidelines: [
			"Use search_literature for a quick discovery pass; use collect_literature for a reproducible corpus workflow.",
			"Results identify leads only. Verify claims against the paper, official artifact, or another primary source.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Paper title, author/title combination, or focused research query" }),
			max_results_per_source: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100, description: "Results from each source; default: 5" }),
			),
		}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await collectLiterature({
				queries: [params.query],
				providers: ["arxiv", "openalex", "crossref"],
				filters: {},
				pagesPerProvider: 1,
				maxResultsPerProvider: params.max_results_per_source ?? 5,
				scope: "personal",
				mode: "once",
				namespace: "default",
				cwd: ctx.cwd,
				signal,
			});
			if (result.run.results.length === 0) {
				const reasons = result.run.failures.map((failure) => failure.provider + ": " + failure.message).join("; ");
				throw new Error(
					"Literature search returned no results." + (reasons ? " Provider failures: " + reasons : ""),
				);
			}
			const errors = result.run.failures.map((failure) => failure.provider + ": " + failure.message);
			const text = [
				"Query: " + params.query,
				"Discovery warning: verify claims against the paper, official artifact, or another primary source.",
				"",
				result.run.results.map(formatResult).join("\n\n"),
				errors.length > 0 ? "\nSource errors: " + errors.join("; ") : "",
			].join("\n");
			const details: SearchDetails = {
				query: params.query,
				resultCount: result.run.results.length,
				errors,
				sourceCounts: Object.fromEntries(
					Object.entries(result.run.sourceCounts).map(([key, value]) => [key, value ?? 0]),
				),
			};
			return { content: [{ type: "text", text }], details };
		},
	});

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch public source",
		description:
			"Fetch a public HTTP(S) primary source. HTML is converted to readable text; JSON/XML/text is returned directly; PDFs are saved to a temporary file for read_pdf. Private, local, credential-bearing, redirect-to-private, and oversized URLs are rejected.",
		promptSnippet: "Fetch and extract a public web source or paper PDF",
		promptGuidelines: [
			"Use fetch_url for canonical arXiv pages, official project pages, documentation, and primary sources; preserve the final URL in citations.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Public http:// or https:// URL" }),
			max_chars: Type.Optional(
				Type.Integer({
					minimum: 1_000,
					maximum: 100_000,
					description: "Maximum returned text characters; default: 50,000",
				}),
			),
		}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let requestedUrl: URL;
			try {
				requestedUrl = new URL(params.url);
			} catch {
				throw new Error("Invalid URL: " + params.url);
			}
			const fetched = await fetchPublicUrl(requestedUrl, { signal });
			if (!fetched.response.ok) {
				throw new Error("Source returned HTTP " + fetched.response.status + ": " + fetched.finalUrl);
			}
			const contentType = fetched.response.headers.get("content-type")?.toLowerCase() ?? "application/octet-stream";
			const isPdf =
				contentType.includes("application/pdf") || extname(fetched.finalUrl.pathname).toLowerCase() === ".pdf";
				if (isPdf) {
					const body = await readResponseBody(fetched.response, 30 * 1024 * 1024);
					const sha256 = createHash("sha256").update(body).digest("hex");
					const outputDirectory = join(tmpdir(), `pi-paper-download-${randomUUID()}`);
					const downloadedPdfPath = join(outputDirectory, `source-${sha256.slice(0, 12)}.pdf`);
					const plan: OperationPlan = {
						kind: "pdf-download",
						summary: "Store one fetched public PDF in a temporary local workspace",
						actor: "interactive-user",
						targets: [{ label: "Temporary PDF", value: downloadedPdfPath, risk: "medium" }],
						details: {
							requestedUrl: requestedUrl.href,
							finalUrl: fetched.finalUrl.href,
							contentType,
							bytes: body.byteLength,
							sha256,
							temporary: true,
						},
					};
					const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
						title: "Store fetched PDF temporarily?",
						unavailableMessage:
							"Fetching PDF bytes is read-only, but storing them requires interactive confirmation. Use interactive Pi or the Paper Agent UI.",
						details: () => [`SHA-256: ${sha256}`, `Bytes: ${body.byteLength}`],
					});
					await runAuthorizedMutation(authorization, plan, async () => {
						await mkdir(outputDirectory, { recursive: false });
						try {
							await writeFile(downloadedPdfPath, body, { flag: "wx" });
						} catch (error) {
							await rm(outputDirectory, { recursive: true, force: true });
							throw error;
						}
					});
				const details: FetchDetails = {
					requestedUrl: requestedUrl.href,
					finalUrl: fetched.finalUrl.href,
					contentType,
					downloadedPdfPath,
					truncated: false,
				};
				return {
					content: [
						{
							type: "text",
							text:
								"Downloaded PDF from " +
								fetched.finalUrl.href +
								"\nTemporary path: " +
								downloadedPdfPath +
								"\nUse read_pdf on this path.",
						},
					],
					details,
				};
			}

			const body = await readResponseBody(fetched.response, 5 * 1024 * 1024);
			const raw = body.toString("utf8");
			const extracted = contentType.includes("html") ? htmlToText(raw) : raw;
			const maxChars = params.max_chars ?? 50_000;
			const truncated = extracted.length > maxChars;
			const text = extracted.slice(0, maxChars);
			const details: FetchDetails = {
				requestedUrl: requestedUrl.href,
				finalUrl: fetched.finalUrl.href,
				contentType,
				truncated,
			};
			return {
				content: [
					{
						type: "text",
						text: [
							"Source: " + fetched.finalUrl.href,
							"Content-Type: " + contentType,
							truncated ? "[Truncated to " + maxChars + " characters]" : "",
							"",
							text,
						].join("\n"),
					},
				],
				details,
			};
		},
	});
}
