import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";
import { absolutePathLocations, createWikiWorkspaceForStore } from "../application/team-personal-sources.ts";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../literature/application/literature-store.ts";
import type { DerivedRecord, PaperRecord } from "../../literature/domain/literature-types.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { configuredTeamCorpusClient, sanitizePaperRecordForTeamProposal } from "../application/team-corpus-client.ts";
import { executeTeamPull, previewTeamPull } from "../application/team-pull.ts";
import { resolveRequestedTopics } from "../application/team-topic-membership.ts";
import type { TeamPageSnapshot } from "../domain/team-corpus-types.ts";
import { teamNamespacePattern, validateTeamNamespace } from "../domain/team-corpus-validation.ts";
import { handleTeamCollaborationTool } from "./team-collaboration-tools.ts";
import { resolveTeamConnection } from "../application/team-connection.ts";

export function registerTeamCorpusClientTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "manage_team_literature_server",
		label: "Manage team literature server",
		description:
			"Search and read reviewed team papers and knowledge, propose four content types, review exact versions, withdraw own proposals, comment, assign reviewers, request changes, read private notifications, curate topics, pull snapshots into personal notes, upload PDFs, or manage backups. Credentials are resolved from protected local team access or environment configuration.",
		promptSnippet: "Use the authenticated shared team literature service",
		promptGuidelines: [
			"Search may reuse team records, but records remain discovery evidence until primary sources are opened.",
			"`search` accepts `topic_ids` (shared categories, listed by the `topics` action) to scope results; the union of the listed categories is returned.",
			"`propose` accepts `topic_ids` to ask for existing shared categories; a reviewer applies them when approving, and a request naming an unknown category is refused.",
			"Propose from personal scope; the service removes personal notes and screening opinions before team storage.",
			"Pull only approved team records; personal notes and screening are never copied back down.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("search"),
				Type.Literal("propose"),
				Type.Literal("propose_derived"),
				Type.Literal("propose_pages"),
				Type.Literal("pull"),
				Type.Literal("review"),
				Type.Literal("audit"),
				Type.Literal("stats"),
				Type.Literal("backup"),
				Type.Literal("search_content"),
				Type.Literal("read_content"),
				Type.Literal("contributions"),
				Type.Literal("discussion"),
				Type.Literal("comment"),
				Type.Literal("assign"),
				Type.Literal("request_changes"),
				Type.Literal("withdraw"),
				Type.Literal("reviewers"),
				Type.Literal("notifications"),
				Type.Literal("read_notifications"),
				Type.Literal("topics"),
				Type.Literal("save_topic"),
				Type.Literal("delete_topic"),
				Type.Literal("pull_knowledge"),
				Type.Literal("personal_artifacts"),
				Type.Literal("propose_artifact"),
				Type.Literal("upload_blob"),
				Type.Literal("restore_drill"),
			]),
			namespace: Type.Optional(Type.String({ pattern: teamNamespacePattern, maxLength: 64 })),
			query: Type.Optional(Type.String()),
			year_from: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			year_to: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
			authors: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			venues: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			publication_types: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
			review_statuses: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("team-proposed"),
						Type.Literal("team-approved"),
						Type.Literal("team-rejected"),
					]),
					{ maxItems: 3 },
				),
			),
			open_access: Type.Optional(Type.Boolean()),
			/** Shared categories for `search` (filter) and `propose` (membership request); `topic_id` edits one. */
			topic_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
			cursor: Type.Optional(Type.String({ pattern: "^\\d+$" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			derived_keys: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
			note_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
			wiki_page_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
			include_pdf: Type.Optional(Type.Boolean()),
			personal_namespace: Type.Optional(Type.String()),
			personal_corpus_root: Type.Optional(Type.String()),
			review_decision: Type.Optional(Type.Union([Type.Literal("team-approved"), Type.Literal("team-rejected")])),
			review_resource: Type.Optional(
				Type.Union([
					Type.Literal("papers"),
					Type.Literal("derived"),
					Type.Literal("pages"),
					Type.Literal("artifacts"),
				]),
			),
			entry_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			review_reason: Type.Optional(Type.String()),
			mine: Type.Optional(Type.Boolean()),
			pending: Type.Optional(Type.Boolean()),
			proposal_status: Type.Optional(Type.String()),
			comment: Type.Optional(Type.String({ maxLength: 10000 })),
			assignee_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			expected_version: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
			notification_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
			topic_id: Type.Optional(Type.String()),
			topic_title: Type.Optional(Type.String({ maxLength: 200 })),
			topic_description: Type.Optional(Type.String({ maxLength: 2000 })),
			topic_entries: Type.Optional(
				Type.Array(
					Type.Object({
						resource: Type.Union([
							Type.Literal("papers"),
							Type.Literal("pages"),
							Type.Literal("derived"),
							Type.Literal("artifacts"),
						]),
						id: Type.String(),
					}),
					{ maxItems: 1000 },
				),
			),
			sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
			backup_path: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = validateTeamNamespace(
				params.namespace ?? resolveTeamConnection(ctx.cwd)?.namespace ?? "default",
			);
			const client = configuredTeamCorpusClient();
			const authorize = async (plan: OperationPlan) => {
				plan = { ...plan, details: { ...plan.details, serverUrl: client.baseUrl.origin, namespace } };
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Write to the team knowledge service?",
					unavailableMessage: "Team write operations require an interactive user confirmation",
				});
				await authorization.manager.consume(authorization.grant, plan);
			};
			const extended = await handleTeamCollaborationTool(params, client, namespace, ctx.cwd, authorize);
			if (extended) return extended;

			if (params.action === "search") {
				const result = await client.search({
					namespace,
					query: params.query,
					yearFrom: params.year_from,
					yearTo: params.year_to,
					authors: params.authors,
					venues: params.venues,
					types: params.publication_types,
					statuses: params.review_statuses,
					openAccess: params.open_access,
					topicIds: params.topic_ids,
					cursor: params.cursor,
					limit: params.limit,
				});
				return {
					content: [
						{
							type: "text",
							text: `Remote team corpus matches: ${result.hits.length}; next cursor: ${result.nextCursor ?? "none"}`,
						},
					],
					details: { namespace, ...result },
				};
			}

			if (params.action === "propose") {
				const personalNamespace = params.personal_namespace ?? "default";
				const store = new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", personalNamespace, params.personal_corpus_root),
					"personal",
					personalNamespace,
				);
				const requested = params.paper_ids
					? await Promise.all(params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })))
					: undefined;
				const missing = requested?.filter((item) => !item.record).map((item) => item.id) ?? [];
				if (missing.length) {
					throw new Error(`personal corpus does not contain requested paper ids: ${missing.join(", ")}`);
				}
				const records = (
					requested
						? requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record))
						: await store.listPapers()
				).map(sanitizePaperRecordForTeamProposal);
				const requestedTopicIds = await resolveRequestedTopics(client, namespace, params.topic_ids);
				await authorize({
					kind: "team-proposal",
					summary: `Propose ${records.length} privacy-scrubbed personal paper record(s) to the team service`,
					actor: "interactive-user",
					targets: records.map((record) => ({
						label: record.title.slice(0, 120),
						value: record.id,
						risk: "high",
					})),
					details: {
						namespace,
						personalNamespace,
						privacy:
							"Personal notes, screening decisions, and previous team review state are removed before transfer.",
						...(requestedTopicIds ? { requestedTopicIds } : {}),
						records,
					},
				});
				const result = await client.proposePapers(namespace, records, { topicIds: requestedTopicIds });
				return {
					content: [
						{
							type: "text",
							text: `Proposed ${records.length} records to ${namespace}${
								requestedTopicIds
									? `; a reviewer applies ${requestedTopicIds.length} requested categories on approval`
									: ""
							}`,
						},
					],
					details: result,
				};
			}

			if (params.action === "propose_derived") {
				if (!params.derived_keys?.length) throw new Error("propose_derived requires derived_keys");
				const personalNamespace = params.personal_namespace ?? "default";
				const store = new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", personalNamespace, params.personal_corpus_root),
					"personal",
					personalNamespace,
				);
				await store.initialize();
				const records: DerivedRecord[] = [];
				const warnings: string[] = [];
				for (const key of params.derived_keys) {
					const record = await store.getDerived(key);
					if (!record) throw new Error(`personal corpus does not contain derived record: ${key}`);
					if (!(await store.getPaper(record.paperId))) {
						throw new Error(
							`derived record ${key} references paper ${record.paperId}, which is not in the personal corpus`,
						);
					}
					records.push(record);
					for (const location of absolutePathLocations(record.result)) {
						warnings.push(`${key}: absolute path retained at ${location}`);
					}
				}
				await authorize({
					kind: "team-proposal",
					summary: `Propose ${records.length} personal derived record(s) to the team service`,
					actor: "interactive-user",
					targets: records.map((record) => ({
						label: `${record.operation} · ${record.key}`.slice(0, 120),
						value: record.key,
						risk: "medium",
					})),
					details: {
						namespace,
						personalNamespace,
						keys: records.map((record) => record.key),
						warnings,
						preview: records,
					},
				});
				const result = await client.proposeDerived(namespace, records);
				return {
					content: [{ type: "text", text: `Proposed ${records.length} derived record(s) to ${namespace}` }],
					details: result,
				};
			}

			if (params.action === "propose_pages") {
				const noteIds = params.note_ids ?? [];
				const wikiPageIds = params.wiki_page_ids ?? [];
				if (!noteIds.length && !wikiPageIds.length) {
					throw new Error("propose_pages requires note_ids or wiki_page_ids");
				}
				const personalNamespace = params.personal_namespace ?? "default";
				const store = new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", personalNamespace, params.personal_corpus_root),
					"personal",
					personalNamespace,
				);
				await store.initialize();
				// The wiki lives next to the corpus under the shared data root.
				const corpusBase = params.personal_corpus_root
					? resolve(ctx.cwd, params.personal_corpus_root)
					: resolve(ctx.cwd, ".paper-agent", "corpus");
				const workspace = createWikiWorkspaceForStore(dirname(corpusBase), personalNamespace, store);
				const records: TeamPageSnapshot[] = [];
				const warnings: string[] = [];
				const now = new Date().toISOString();
				for (const id of noteIds) {
					const note = await store.getResearchNote(id);
					if (!note) throw new Error(`personal knowledge base does not contain research note: ${id}`);
					records.push({
						key: `note.${id}`,
						sourceId: id,
						sourceNamespace: personalNamespace,
						kind: "note",
						title: note.title,
						markdown: note.markdown,
						contentHash: note.contentHash,
						revision: note.revision,
						paperIds: note.papers.map((paper) => paper.id),
						createdAt: now,
					});
				}
				for (const id of wikiPageIds) {
					const detail = await workspace.get(id);
					if (!detail) throw new Error(`personal wiki does not contain page: ${id}`);
					const page = detail.page;
					records.push({
						key: `wiki.${id}`,
						sourceId: id,
						sourceNamespace: personalNamespace,
						kind: "wiki",
						title: page.title,
						markdown: page.markdown,
						contentHash: page.contentHash,
						revision: 0,
						paperIds: [
							...new Set([
								...page.paperIds,
								...page.evidence.flatMap((item: { paperId?: string }) => (item.paperId ? [item.paperId] : [])),
							]),
						],
						createdAt: now,
					});
				}
				for (const record of records) {
					for (const location of absolutePathLocations(record.markdown.split("\n"))) {
						warnings.push(`${record.key}: absolute path retained at ${location}`);
					}
				}
				await authorize({
					kind: "team-proposal",
					summary: `Propose ${records.length} personal knowledge page(s) to the team service`,
					actor: "interactive-user",
					targets: records.map((record) => ({
						label: `${record.kind} · ${record.title}`.slice(0, 120),
						value: record.key,
						risk: "medium",
					})),
					details: {
						namespace,
						personalNamespace,
						keys: records.map((record) => record.key),
						warnings,
						preview: records,
					},
				});
				const result = await client.proposePages(namespace, records);
				return {
					content: [{ type: "text", text: `Proposed ${records.length} knowledge page(s) to ${namespace}` }],
					details: result,
				};
			}

			if (params.action === "pull") {
				if (!params.paper_ids?.length) throw new Error("pull requires paper_ids");
				const personalNamespace = params.personal_namespace ?? "default";
				const includePdf = params.include_pdf ?? false;
				const store = new LiteratureStore(
					resolveCorpusRoot(ctx.cwd, "personal", personalNamespace, params.personal_corpus_root),
					"personal",
					personalNamespace,
				);
				await store.initialize();
				const previews = await previewTeamPull(client, namespace, params.paper_ids);
				await authorize({
					kind: "personal-corpus-write",
					summary: `Pull ${previews.length} team paper record(s) into personal namespace ${personalNamespace}`,
					actor: "interactive-user",
					targets: previews.map((preview) => ({
						label: preview.record.title.slice(0, 120),
						value: preview.record.id,
						risk: "medium",
					})),
					details: {
						namespace,
						personalNamespace,
						includePdf,
						papers: previews.map((preview) => ({
							id: preview.record.id,
							title: preview.record.title,
							hasPdf: Boolean(preview.version),
							pdfSha256: preview.version?.sha256,
						})),
					},
				});
				const result = await executeTeamPull({ client, namespace, store, previews, includePdf });
				const failedPdfs = result.pdfs.filter((entry) => entry.status === "failed").length;
				return {
					content: [
						{
							type: "text",
							text:
								`Pulled ${result.pulled} paper(s) into ${personalNamespace}: ${result.created.length} created, ` +
								`${result.updated.length} updated, ${result.unchanged.length} unchanged` +
								(includePdf ? `; PDFs failed: ${failedPdfs}` : ""),
						},
					],
					details: result,
				};
			}

			if (params.action === "review") {
				const resource = params.review_resource ?? "papers";
				const ids = params.entry_ids ?? params.paper_ids ?? [];
				if (!ids.length || !params.review_decision) {
					throw new Error("review requires entry_ids and review_decision");
				}
				const preview = await client.previewReview(namespace, resource, ids);
				const versions = Object.fromEntries(preview.entries.map((entry) => [entry.id, entry.version]));
				await authorize({
					kind: "team-review",
					summary: `${params.review_decision === "team-approved" ? "Approve" : "Reject"} ${ids.length} team ${resource} proposal(s)`,
					actor: "interactive-user",
					targets: preview.entries.map((entry) => ({ label: entry.title, value: entry.id, risk: "high" })),
					details: {
						namespace,
						decision: params.review_decision,
						reason: params.review_reason,
						preview: preview.entries,
					},
				});
				const review =
					resource === "papers"
						? client.reviewPapers.bind(client)
						: resource === "derived"
							? client.reviewDerived.bind(client)
							: resource === "pages"
								? client.reviewPages.bind(client)
								: client.reviewArtifacts.bind(client);
				const result = await review(namespace, ids, params.review_decision, params.review_reason, versions);
				return {
					content: [{ type: "text", text: `Reviewed ${ids.length} team records` }],
					details: result,
				};
			}

			if (params.action === "audit" || params.action === "stats") {
				const result = params.action === "audit" ? await client.audit(namespace) : await client.stats(namespace);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			}

			if (params.action !== "backup") throw new Error("Unsupported team action");
			await authorize({
				kind: "backup-restore",
				summary: `Create a server-side backup of team namespace ${namespace}`,
				actor: "interactive-user",
				targets: [{ label: "Team namespace", value: namespace, risk: "medium" }],
				details: { namespace, action: "backup" },
			});
			const result = await client.backup(namespace);
			return { content: [{ type: "text", text: "Team corpus backup completed" }], details: result };
		},
	});
}
