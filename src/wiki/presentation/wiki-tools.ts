import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { loadPaperAgentConfigSync } from "../../config/application/config-service.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../literature/application/literature-store.ts";
import { runAuthorizedMutation } from "../../literature/application/literature-write.ts";
import { ResearchNotebook } from "../../research/application/research-notebook.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { WikiWorkspace } from "../application/wiki-workspace.ts";
import type {
	IngestWikiPageInput,
	WikiEvidenceInput,
	WikiIngestPreview,
	WikiPageType,
	WikiPageStatus,
} from "../domain/wiki-types.ts";

function workspace(cwd: string, namespace: string): WikiWorkspace {
	const config = loadPaperAgentConfigSync(cwd);
	const dataRoot = resolve(config.storage.dataRoot ?? join(cwd, ".paper-agent"));
	const store = new LiteratureStore(
		resolveCorpusRoot(cwd, "personal", namespace, config.storage.corpusRoot),
		"personal",
		namespace,
	);
	const notebook = new ResearchNotebook(store);
	return new WikiWorkspace(dataRoot, namespace, {
		resolvePaper: async (id) => {
			const record = await store.getPaper(id);
			if (!record) return undefined;
			const versions = await store.listPaperVersions(id);
			const preferred = versions.find((version) => version.isPreferred) ?? versions[0];
			return {
				kind: "paper",
				id,
				title: record.title,
				version: preferred?.sha256 ?? "metadata",
				updatedAt: preferred?.retrievedAt ?? record.curation?.reading?.updatedAt,
			};
		},
		resolveNote: async (id) => {
			const note = await notebook.get(id);
			return note
				? {
						kind: "note",
						id,
						title: note.title,
						version: note.contentHash,
						revision: note.revision,
						updatedAt: note.updatedAt,
					}
				: undefined;
		},
	});
}

const wikiPageType = Type.Union([
	Type.Literal("topic"),
	Type.Literal("concept"),
	Type.Literal("method"),
	Type.Literal("system"),
	Type.Literal("dataset"),
	Type.Literal("synthesis"),
	Type.Literal("question"),
]);

const wikiPageStatus = Type.Union([
	Type.Literal("draft"),
	Type.Literal("needs-review"),
	Type.Literal("reviewed"),
	Type.Literal("conflicted"),
	Type.Literal("all"),
]);

const evidenceLocator = Type.Object({
	pdf_page: Type.Optional(Type.Integer({ minimum: 1 })),
	section: Type.Optional(Type.String({ maxLength: 300 })),
	object: Type.Optional(Type.String({ maxLength: 300 })),
	note_revision: Type.Optional(Type.Integer({ minimum: 1 })),
	note_hash: Type.Optional(Type.String({ maxLength: 128 })),
	url: Type.Optional(Type.String({ maxLength: 2_000 })),
	commit: Type.Optional(Type.String({ maxLength: 200 })),
	path: Type.Optional(Type.String({ maxLength: 1_000 })),
	line: Type.Optional(Type.Integer({ minimum: 1 })),
});

const wikiEvidence = Type.Object({
	id: Type.String({ pattern: "^E[1-9]\\d*$" }),
	kind: Type.Union([Type.Literal("paper"), Type.Literal("note"), Type.Literal("artifact"), Type.Literal("public")]),
	source_id: Type.Optional(Type.String({ maxLength: 512 })),
	paper_id: Type.Optional(Type.String({ maxLength: 512 })),
	version: Type.Optional(Type.String({ maxLength: 256 })),
	locator: evidenceLocator,
});

const pageChange = Type.Object({
	page_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	expected_content_hash: Type.Optional(Type.String({ maxLength: 128 })),
	title: Type.String({ minLength: 1, maxLength: 300 }),
	type: wikiPageType,
	markdown: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
	aliases: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 100 })),
	tags: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 })),
	evidence: Type.Array(wikiEvidence, { maxItems: 200 }),
	paper_ids: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 200 })),
	source_note_ids: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 100 })),
});

function changeInput(value: {
	page_id?: string;
	expected_content_hash?: string;
	title: string;
	type: WikiPageType;
	markdown: string;
	aliases?: string[];
	tags?: string[];
	evidence: Array<{
		id: string;
		kind: WikiEvidenceInput["kind"];
		source_id?: string;
		paper_id?: string;
		version?: string;
		locator: {
			pdf_page?: number;
			section?: string;
			object?: string;
			note_revision?: number;
			note_hash?: string;
			url?: string;
			commit?: string;
			path?: string;
			line?: number;
		};
	}>;
	paper_ids?: string[];
	source_note_ids?: string[];
}): IngestWikiPageInput {
	return {
		pageId: value.page_id,
		expectedContentHash: value.expected_content_hash,
		title: value.title,
		type: value.type,
		markdown: value.markdown,
		aliases: value.aliases,
		tags: value.tags,
		evidence: value.evidence.map((item) => ({
			id: item.id,
			kind: item.kind,
			...(item.source_id ? { sourceId: item.source_id } : {}),
			...(item.paper_id ? { paperId: item.paper_id } : {}),
			...(item.version ? { version: item.version } : {}),
			locator: {
				...(item.locator.pdf_page ? { pdfPage: item.locator.pdf_page } : {}),
				...(item.locator.section ? { section: item.locator.section } : {}),
				...(item.locator.object ? { object: item.locator.object } : {}),
				...(item.locator.note_revision ? { noteRevision: item.locator.note_revision } : {}),
				...(item.locator.note_hash ? { noteHash: item.locator.note_hash } : {}),
				...(item.locator.url ? { url: item.locator.url } : {}),
				...(item.locator.commit ? { commit: item.locator.commit } : {}),
				...(item.locator.path ? { path: item.locator.path } : {}),
				...(item.locator.line ? { line: item.locator.line } : {}),
			},
		})),
		paperIds: value.paper_ids,
		sourceNoteIds: value.source_note_ids,
	};
}

function wikiIngestPlan(preview: WikiIngestPreview): OperationPlan {
	const creates = preview.changes.filter((change) => change.action === "create").length;
	const updates = preview.changes.filter((change) => change.action === "update").length;
	return {
		kind: "wiki-write",
		summary: `${preview.summary} (${creates} create, ${updates} update)`,
		actor: "paper-agent",
		targets: preview.changes.map((change) => ({
			label: change.pageId ? "Wiki page" : "New Wiki page",
			value: `${preview.namespace}/${change.title}`,
			risk: "medium",
		})),
		details: {
			namespace: preview.namespace,
			previewFingerprint: preview.fingerprint,
			changes: preview.changes.map((change) => ({
				action: change.action,
				pageId: change.pageId,
				title: change.title,
				type: change.type,
				relativePath: change.relativePath,
			})),
			issues: preview.issues,
		},
	};
}

function renderSearchText(result: Awaited<ReturnType<WikiWorkspace["search"]>>): string {
	if (!result.pages.length) {
		return "No deposited Wiki page matched. Do not answer from temporary materials as if it came from the Wiki.";
	}
	return result.pages
		.map((page) => {
			const match = page.match
				? ` match=${page.match.reason}${page.match.heading ? ` heading=${page.match.heading}` : ""}`
				: "";
			const evidence = page.match?.evidenceIds.length ? ` evidence=${page.match.evidenceIds.join(",")}` : "";
			const snippet = page.snippet ? `\n  ${stripMarkup(page.snippet)}` : page.match?.snippet ? `\n  ${stripMarkup(page.match.snippet)}` : "";
			return `- ${page.title} (${page.id}, ${page.type}, ${page.status})${match}${evidence}${snippet}`;
		})
		.join("\n");
}

function stripMarkup(value: string): string {
	return value.replaceAll("<mark>", "").replaceAll("</mark>", "").replace(/\s+/g, " ").trim();
}

export function registerWikiTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_research_wiki",
		label: "Search research Wiki",
		description:
			"Search or read the curated Markdown research Wiki for one personal namespace. Search can use page metadata, body chunks, aliases, source paper/note ids, type, and status. This tool never falls back to transient search results, research notes, PDFs, or model memory.",
		promptSnippet: "Query deposited research knowledge before claiming the personal Wiki contains an answer",
		promptGuidelines: [
			"Treat results as curated Wiki content and retain their evidence ids and source ids in the answer.",
			"Read the full page by page_id before making a substantive answer; one-hop related pages are navigation, not additional evidence.",
			"If no page supports the question, say that the knowledge has not been deposited; suggest research or an explicit ingest instead of silently using other materials.",
		],
		parameters: Type.Object({
			namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 64, default: "default" })),
			page_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			query: Type.Optional(Type.String({ maxLength: 500 })),
			paper_id: Type.Optional(Type.String({ maxLength: 512 })),
			note_id: Type.Optional(Type.String({ maxLength: 128 })),
			type: Type.Optional(wikiPageType),
			status: Type.Optional(wikiPageStatus),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 20 })),
			include_related: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const wiki = workspace(ctx.cwd, namespace);
			if (params.page_id) {
				const found = await wiki.get(params.page_id);
				if (!found) throw new Error(`Wiki page not found: ${params.page_id}`);
				return {
					content: [
						{
							type: "text",
							text: [
								`# ${found.page.title}`,
								`ID: ${found.page.id}; type: ${found.page.type}; status: ${found.page.status}`,
								`Evidence: ${found.page.evidence.map((item) => item.id).join(", ") || "none"}`,
								...(found.backlinks.length ? [`Backlinks: ${found.backlinks.map((item) => item.title).join(", ")}`] : []),
								"",
								found.page.markdown,
							].join("\n"),
						},
					],
					details: { namespace, ...found },
				};
			}
			const result = await wiki.search({
				query: params.query,
				paperId: params.paper_id,
				noteId: params.note_id,
				type: params.type ?? "all",
				status: (params.status ?? "all") as WikiPageStatus | "all",
				limit: params.limit,
				includeRelated: params.include_related,
			});
			return {
				content: [{ type: "text", text: renderSearchText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "ingest_research_wiki",
		label: "Ingest research Wiki",
		description:
			"Preview or apply one evidence-linked batch of curated Markdown Wiki pages. Preview validates sources and produces a fingerprint; apply requires that fingerprint and writes the complete batch with rollback on failure.",
		promptSnippet: "Deposit a synthesized, evidence-linked page batch only when the user explicitly asks",
		promptGuidelines: [
			"Never ingest automatically after reading or searching. Obtain an explicit user request to deposit knowledge.",
			"Use inspect_agent_tools first and verify each source with the available PDF, MinerU, Artifact, note, and Wiki tools.",
			"Every stable claim must use [E1] and cite an exact page, section, object, note revision, commit, or official URL. MinerU is navigation, not primary evidence.",
			"Preview the complete batch and show conflicts/differences before apply; after apply run search_research_wiki and lint_research_wiki.",
		],
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("preview"), Type.Literal("apply")]),
			namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 64, default: "default" })),
			summary: Type.String({ minLength: 1, maxLength: 500 }),
			changes: Type.Array(pageChange, { minItems: 1, maxItems: 100 }),
			preview_fingerprint: Type.Optional(Type.String({ maxLength: 128 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const wiki = workspace(ctx.cwd, namespace);
			const requestInput = {
				namespace,
				summary: params.summary,
				changes: params.changes.map(changeInput),
			};
			const preview = await wiki.previewIngest(requestInput);
			if (params.mode === "preview") {
				return {
					content: [
						{
							type: "text",
							text: [
								`Wiki preview ${preview.fingerprint}`,
								...preview.changes.map(
									(change) =>
										`- ${change.action}: ${change.title}${change.relativePath ? ` (${change.relativePath})` : ""}; evidence=${change.evidence.map((item) => item.id).join(",") || "none"}`,
								),
								...preview.issues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`),
							].join("\n"),
						},
					],
					details: { namespace, preview },
				};
			}
			if (!params.preview_fingerprint) throw new Error("preview_fingerprint is required when mode=apply");
			if (params.preview_fingerprint !== preview.fingerprint) {
				throw new Error("Wiki preview fingerprint changed; run preview again");
			}
			if (preview.changes.some((change) => change.action === "conflict")) {
				throw new Error(preview.issues.map((issue) => issue.message).join("; "));
			}
			if (!preview.changes.some((change) => change.action === "create" || change.action === "update")) {
				return {
					content: [{ type: "text", text: "Wiki batch is already up to date; no write was needed." }],
					details: { namespace, preview },
				};
			}
			const plan = wikiIngestPlan(preview);
			const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
				title: "写入研究 Wiki？",
				unavailableMessage: "研究 Wiki 写入需要交互确认，请使用 Web 界面。",
				details: () => [
					`页面数：${preview.changes.length}`,
					`来源证据：${preview.changes.reduce((sum, change) => sum + change.evidence.length, 0)}`,
					`冲突：${preview.changes.filter((change) => change.action === "conflict").length}`,
				],
			});
			const result = await runAuthorizedMutation(authorization, plan, () => wiki.applyIngest(preview));
			return {
				content: [
					{
						type: "text",
						text: `Wiki batch saved: ${result.pages.length} page(s), fingerprint ${result.previewFingerprint}`,
					},
				],
				details: { namespace, preview, result },
			};
		},
	});

	pi.registerTool({
		name: "lint_research_wiki",
		label: "Lint research Wiki",
		description:
			"Synchronize and inspect the Markdown research Wiki for schema, evidence, provenance, links, duplicates, staleness, and indexing problems. This tool is read-only.",
		promptSnippet: "Audit Wiki structure and provenance without changing files",
		parameters: Type.Object({
			namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 64, default: "default" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const result = await workspace(ctx.cwd, namespace).lint();
			const errors = result.issues.filter((issue) => issue.severity === "error").length;
			const warnings = result.issues.filter((issue) => issue.severity === "warning").length;
			return {
				content: [
					{
						type: "text",
						text: result.issues.length
							? [
									`Wiki lint: ${result.pageCount} pages, ${errors} errors, ${warnings} warnings.`,
									...result.issues.map(
										(issue) =>
											`- [${issue.severity}] ${issue.code}${issue.pageId ? ` page=${issue.pageId}` : ""}${issue.evidenceId ? ` evidence=${issue.evidenceId}` : ""}: ${issue.message}`,
									),
								].join("\n")
							: `Wiki lint passed: ${result.pageCount} pages indexed.`,
					},
				],
				details: { namespace, ...result },
			};
		},
	});
}
