import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { htmlToText, readResponseBody } from "../../shared/infrastructure/network-content.ts";
import { fetchPublicUrl } from "../../shared/infrastructure/network-security.ts";
import { collectLiterature } from "../application/literature-collection.ts";
import { runAuthorizedMutation } from "../application/literature-write.ts";
import { paperPrimaryUrl } from "../domain/literature-identifiers.ts";
import type { LiteratureProvider, PaperRecord, SearchRun } from "../domain/literature-types.ts";

export interface SearchDetails {
	query: string;
	searchRunId: string;
	resultCount: number;
	errors: string[];
	sourceCounts: Record<string, number>;
	discoveryProviders: string[];
	enrichmentProviders: string[];
	candidates: Array<{
		paperId: string;
		title: string;
		authors: string[];
		doi?: string;
		arxivId?: string;
		url?: string;
		providers: string[];
	}>;
}

const QUICK_SEARCH_PROVIDERS: LiteratureProvider[] = ["arxiv", "openalex", "crossref"];
const QUICK_SEARCH_PROVIDER_NAMES = new Set<string>(QUICK_SEARCH_PROVIDERS);

function formatResult(result: PaperRecord, index: number): string {
	const fields = [
		`${index + 1}. [${[...new Set(result.provenance.map((item) => item.provider))].join("+")}] ${result.title}`,
		`   Paper ID: ${result.id}`,
		`   Authors: ${result.authors.slice(0, 12).join(", ") || "unavailable"}${result.authors.length > 12 ? ", et al." : ""}`,
		`   Year: ${result.year ?? "unavailable"}`,
		`   URL: ${paperPrimaryUrl(result) ?? "unavailable"}`,
	];
	if (result.identifiers.doi) fields.push(`   DOI: ${result.identifiers.doi}`);
	if (result.citationCount !== undefined) fields.push(`   cited_by_count: ${result.citationCount}`);
	if (result.abstract) fields.push(`   Abstract: ${result.abstract.slice(0, 1_200)}`);
	return fields.join("\n");
}

export function buildSearchDetails(query: string, run: SearchRun): SearchDetails {
	const enrichmentProviders = [
		...new Set(
			run.results.flatMap((record) =>
				record.provenance
					.map((item) => item.provider)
					.filter((provider) => !QUICK_SEARCH_PROVIDER_NAMES.has(provider)),
			),
		),
	].sort();
	return {
		query,
		searchRunId: run.id,
		resultCount: run.results.length,
		errors: run.failures.map((failure) => `${failure.provider}: ${failure.message}`),
		discoveryProviders: QUICK_SEARCH_PROVIDERS,
		enrichmentProviders,
		sourceCounts: Object.fromEntries(Object.entries(run.sourceCounts).map(([key, value]) => [key, value ?? 0])),
		candidates: run.results.map((record) => ({
			paperId: record.id,
			title: record.title,
			authors: record.authors,
			doi: record.identifiers.doi,
			arxivId: record.identifiers.arxivId,
			url: paperPrimaryUrl(record),
			providers: [...new Set(record.provenance.map((item) => item.provider))],
		})),
	};
}

export function registerLiteratureDiscoveryTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_literature",
		label: "Search literature",
		description:
			"Quick search across arXiv, OpenAlex, and Crossref with DOI/arXiv/title deduplication and partial-source failure reporting. For reproducible searches use collect_literature.",
		promptSnippet: "Quickly search three literature metadata providers",
		promptGuidelines: [
			"Use the complete title plus the first author when filling missing metadata.",
			"Use the returned searchRunId and Paper ID for later list edits or saves.",
			"Verify technical claims against the paper or another primary source.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Paper title, author/title combination, or focused research query" }),
			max_results_per_source: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 5 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await collectLiterature({
				queries: [params.query],
				providers: QUICK_SEARCH_PROVIDERS,
				filters: {},
				pagesPerProvider: 1,
				maxResultsPerProvider: params.max_results_per_source ?? 5,
				scope: "personal",
				mode: "once",
				namespace: "default",
				cwd: ctx.cwd,
				signal,
			});
			if (!result.run.results.length) {
				const reasons = result.run.failures.map((failure) => `${failure.provider}: ${failure.message}`).join("; ");
				throw new Error(`Literature search returned no results.${reasons ? ` Provider failures: ${reasons}` : ""}`);
			}
			const details = buildSearchDetails(params.query, result.run);
			return {
				content: [
					{
						type: "text",
						text: [
							`Search run: ${result.run.id}`,
							`Query: ${params.query}`,
							`Discovery providers: ${details.discoveryProviders.join(", ")}`,
							`DOI enrichment providers observed: ${details.enrichmentProviders.join(", ") || "none"}`,
							"",
							result.run.results.map(formatResult).join("\n\n"),
							details.errors.length ? `\nSource errors: ${details.errors.join("; ")}` : "",
						].join("\n"),
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch public source",
		description:
			"Fetch a public HTTP(S) primary source. HTML is converted to text; PDFs are saved temporarily for read_pdf. Private, local, credential-bearing, redirect-to-private, and oversized URLs are rejected.",
		promptSnippet: "Fetch and extract a public web source or paper PDF",
		parameters: Type.Object({
			url: Type.String({ description: "Public http:// or https:// URL" }),
			max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000, default: 50_000 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let requestedUrl: URL;
			try {
				requestedUrl = new URL(params.url);
			} catch {
				throw new Error(`Invalid URL: ${params.url}`);
			}
			const fetched = await fetchPublicUrl(requestedUrl, { signal });
			if (!fetched.response.ok)
				throw new Error(`Source returned HTTP ${fetched.response.status}: ${fetched.finalUrl}`);
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
						bytes: body.byteLength,
						sha256,
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
				return {
					content: [
						{
							type: "text",
							text: `Downloaded PDF from ${fetched.finalUrl.href}\nTemporary path: ${downloadedPdfPath}\nUse read_pdf on this path.`,
						},
					],
					details: {
						requestedUrl: requestedUrl.href,
						finalUrl: fetched.finalUrl.href,
						contentType,
						downloadedPdfPath,
						truncated: false,
					},
				};
			}
			const body = await readResponseBody(fetched.response, 5 * 1024 * 1024);
			const extracted = contentType.includes("html") ? htmlToText(body.toString("utf8")) : body.toString("utf8");
			const maxChars = params.max_chars ?? 50_000;
			const truncated = extracted.length > maxChars;
			return {
				content: [
					{
						type: "text",
						text: `Source: ${fetched.finalUrl.href}\nContent-Type: ${contentType}\n${truncated ? `[Truncated to ${maxChars} characters]\n` : ""}\n${extracted.slice(0, maxChars)}`,
					},
				],
				details: { requestedUrl: requestedUrl.href, finalUrl: fetched.finalUrl.href, contentType, truncated },
			};
		},
	});
}
