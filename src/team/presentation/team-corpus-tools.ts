import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { absolutePathLocations } from "../../app/application/paper-agent-team-operations.ts";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import { LiteratureStore, resolveCorpusRoot } from "../../literature/application/literature-store.ts";
import type { DerivedRecord, PaperRecord } from "../../literature/domain/literature-types.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { configuredTeamCorpusClient, sanitizePaperRecordForTeamProposal } from "../application/team-corpus-client.ts";
import { executeTeamPull, previewTeamPull } from "../application/team-pull.ts";
import { teamNamespacePattern, validateTeamNamespace } from "../domain/team-corpus-validation.ts";

export function registerTeamCorpusClientTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "manage_team_literature_server",
		label: "Manage team literature server",
		description:
			"Search a centrally deployed team corpus, propose privacy-scrubbed personal records, pull approved team papers (optionally with their PDFs) into the personal library, review proposals, inspect audit state, or trigger an administrator backup. Credentials come only from environment variables.",
		promptSnippet: "Use the authenticated shared team literature service",
		promptGuidelines: [
			"Search may reuse team records, but records remain discovery evidence until primary sources are opened.",
			"Propose from personal scope; the service removes personal notes and screening opinions before team storage.",
			"Pull only approved team records; personal notes and screening are never copied back down.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("search"),
				Type.Literal("propose"),
				Type.Literal("propose_derived"),
				Type.Literal("pull"),
				Type.Literal("review"),
				Type.Literal("audit"),
				Type.Literal("stats"),
				Type.Literal("backup"),
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
					Type.Union([Type.Literal("team-proposed"), Type.Literal("team-approved"), Type.Literal("team-rejected")]),
					{ maxItems: 3 },
				),
			),
			open_access: Type.Optional(Type.Boolean()),
			cursor: Type.Optional(Type.String({ pattern: "^\\d+$" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			derived_keys: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
			include_pdf: Type.Optional(Type.Boolean()),
			personal_namespace: Type.Optional(Type.String()),
			personal_corpus_root: Type.Optional(Type.String()),
			review_decision: Type.Optional(Type.Union([Type.Literal("team-approved"), Type.Literal("team-rejected")])),
			review_reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = validateTeamNamespace(params.namespace ?? "default");
			const client = configuredTeamCorpusClient();
			const authorize = async (plan: OperationPlan) => {
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Write to the team knowledge service?",
					unavailableMessage: "Team write operations require an interactive user confirmation",
				});
				await authorization.manager.consume(authorization.grant, plan);
			};

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
						records,
					},
				});
				const result = await client.proposePapers(namespace, records);
				return {
					content: [{ type: "text", text: `Proposed ${records.length} records to ${namespace}` }],
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
					details: { namespace, personalNamespace, keys: records.map((record) => record.key), warnings },
				});
				const result = await client.proposeDerived(namespace, records);
				return {
					content: [{ type: "text", text: `Proposed ${records.length} derived record(s) to ${namespace}` }],
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
				if (!params.paper_ids?.length || !params.review_decision) {
					throw new Error("review requires paper_ids and review_decision");
				}
				await authorize({
					kind: "team-review",
					summary: `${params.review_decision === "team-approved" ? "Approve" : "Reject"} ${params.paper_ids.length} team paper proposal(s)`,
					actor: "interactive-user",
					targets: params.paper_ids.map((id) => ({ label: "Team paper", value: id, risk: "high" })),
					details: { namespace, decision: params.review_decision, reason: params.review_reason },
				});
				const result = await client.reviewPapers(
					namespace,
					params.paper_ids,
					params.review_decision,
					params.review_reason,
				);
				return {
					content: [{ type: "text", text: `Reviewed ${params.paper_ids.length} team records` }],
					details: result,
				};
			}

			if (params.action === "audit" || params.action === "stats") {
				const result = params.action === "audit" ? await client.audit(namespace) : await client.stats(namespace);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			}

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
