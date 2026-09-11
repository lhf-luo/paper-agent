import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestInteractiveOperationAuthorization } from "../../app/presentation/interactive-operation-consent.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { corpusAnnotationPlan, corpusExportFilename, corpusExportPlan } from "../application/corpus-operations.ts";
import { corpusPromotionPlan, corpusTeamReviewPlan } from "../application/literature-filtering.ts";
import { LiteratureStore, resolveCorpusRoot } from "../application/literature-store.ts";
import { runAuthorizedMutation } from "../application/literature-write.ts";
import type { PaperRecord } from "../domain/literature-types.ts";
import { scopeSchema } from "./collection-tool-schemas.ts";

export function registerLiteratureCorpusTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "manage_literature_corpus",
		label: "Manage literature corpus",
		description:
			"Audit, export, annotate, delete, or review a persistent corpus, or explicitly propose selected personal records to a team corpus. Destructive deletion is personal-only and requires exact confirmation.",
		promptSnippet: "Audit, curate, delete, review, export, or promote reusable literature records",
		promptGuidelines: [
			"Keep personal and team namespaces separate; use promote only after checking record relevance and provenance.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("audit"),
				Type.Literal("export"),
				Type.Literal("annotate"),
				Type.Literal("delete"),
				Type.Literal("promote"),
				Type.Literal("review"),
			]),
			scope: Type.Optional(scopeSchema),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			format: Type.Optional(
				Type.Union([Type.Literal("markdown"), Type.Literal("csv"), Type.Literal("bibtex"), Type.Literal("json")]),
			),
			filename: Type.Optional(Type.String()),
			paper_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			target_namespace: Type.Optional(Type.String()),
			target_corpus_root: Type.Optional(Type.String()),
			contributor: Type.Optional(Type.String({ description: "Required for annotate and promote" })),
			tags: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
			note: Type.Optional(Type.String()),
			screening_status: Type.Optional(
				Type.Union([
					Type.Literal("unreviewed"),
					Type.Literal("include"),
					Type.Literal("exclude"),
					Type.Literal("maybe"),
				]),
			),
			screening_reason: Type.Optional(Type.String()),
			review_decision: Type.Optional(Type.Union([Type.Literal("team-approved"), Type.Literal("team-rejected")])),
			reviewer: Type.Optional(Type.String()),
			review_reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "personal";
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, scope, namespace, params.corpus_root),
				scope,
				namespace,
			);
			if (params.action === "audit") {
				const audit = await store.audit({ readOnly: true });
				return {
					content: [{ type: "text", text: JSON.stringify(audit, null, 2) }],
					details: { ...audit, corpusPath: store.root },
				};
			}
			if (params.action === "delete") {
				if (scope !== "personal") throw new Error("Paper deletion is only available in personal scope");
				if (!params.paper_ids?.length) throw new Error("paper_ids is required when action=delete");
				const records = await Promise.all(params.paper_ids.map((id) => store.getPaper(id)));
				const plan: OperationPlan = {
					kind: "personal-paper-remove",
					summary: `Delete ${params.paper_ids.length} personal literature record(s) from ${namespace}`,
					targets: [{ label: "personal-corpus", value: store.root, risk: "high" }],
					details: {
						namespace,
						paperIds: [...params.paper_ids].sort(),
						titles: records
							.filter((record): record is PaperRecord => Boolean(record))
							.map((record) => record.title),
					},
				};
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Delete personal literature records?",
					unavailableMessage: "Deleting personal literature records requires interactive confirmation.",
				});
				await authorization.manager.consume(authorization.grant, plan);
				const deleted = await store.deletePapers(params.paper_ids);
				return {
					content: [
						{
							type: "text",
							text: `Deleted: ${deleted.deleted.length}; missing: ${deleted.missing.length}; blob warnings: ${deleted.blobWarnings.length}`,
						},
					],
					details: { ...deleted, corpusPath: store.root },
				};
			}
			if (params.action === "export") {
				const format = params.format ?? "markdown";
				const filename = corpusExportFilename(format, params.filename);
				const records = await store.listPapers();
				const plan = corpusExportPlan(store, format, filename, records);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Export literature corpus?",
					unavailableMessage: "Corpus export requires interactive confirmation before writing the export file.",
				});
				const path = await runAuthorizedMutation(authorization, plan, () =>
					store.export(format, filename, records),
				);
				return {
					content: [{ type: "text", text: `Exported ${format} corpus to ${path}` }],
					details: { exportPath: path, corpusPath: store.root },
				};
			}
			if (params.action === "annotate") {
				if (scope === "team") {
					throw new Error(
						"Personal-style annotations cannot be written directly to team scope; use review for team decisions",
					);
				}
				if (!params.paper_ids?.length) throw new Error("paper_ids is required when action=annotate");
				if (!params.contributor?.trim()) throw new Error("contributor is required when action=annotate");
				if (!params.tags?.length && !params.note?.trim() && !params.screening_status) {
					throw new Error("annotate requires tags, note, or screening_status");
				}
				const requested = await Promise.all(
					params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })),
				);
				const missing = requested.filter((item) => !item.record).map((item) => item.id);
				if (missing.length)
					throw new Error(`Paper ids were not found in the personal corpus: ${missing.join(", ")}`);
				const records = requested
					.map((item) => item.record)
					.filter((record): record is PaperRecord => Boolean(record));
				const annotation = {
					author: params.contributor.trim(),
					tags: params.tags,
					note: params.note,
					screeningStatus: params.screening_status,
					screeningReason: params.screening_reason,
				};
				const plan = corpusAnnotationPlan(store, records, annotation);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Update personal literature annotations?",
					unavailableMessage: "Personal annotations require interactive confirmation before they are saved.",
				});
				const updated = await runAuthorizedMutation(authorization, plan, async () => {
					const values = [];
					for (const record of records) values.push(await store.annotatePaper(record.id, annotation));
					return values;
				});
				return {
					content: [{ type: "text", text: `Annotated ${updated.length} records in ${store.root}` }],
					details: { updated, corpusPath: store.root },
				};
			}
			if (params.action === "review") {
				if (scope !== "team") throw new Error("Review action requires scope=team");
				if (!params.paper_ids?.length) throw new Error("paper_ids is required when action=review");
				if (!params.reviewer?.trim()) throw new Error("reviewer is required when action=review");
				if (!params.review_decision) throw new Error("review_decision is required when action=review");
				const decision = params.review_decision;
				const requested = await Promise.all(
					params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })),
				);
				const missing = requested.filter((item) => !item.record).map((item) => item.id);
				if (missing.length) throw new Error(`Paper ids were not found in the team corpus: ${missing.join(", ")}`);
				const records = requested
					.map((item) => item.record)
					.filter((record): record is PaperRecord => Boolean(record));
				const reviewer = params.reviewer.trim();
				const plan = corpusTeamReviewPlan(store, records, decision, reviewer, params.review_reason);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Review local team proposals?",
					unavailableMessage: "Team review decisions require interactive confirmation before they are saved.",
				});
				const reviewed = await runAuthorizedMutation(authorization, plan, async () => {
					const values = [];
					for (const record of records) {
						values.push(await store.reviewTeamPaper(record.id, decision, reviewer, params.review_reason));
					}
					return values;
				});
				return {
					content: [{ type: "text", text: `Reviewed ${reviewed.length} team records in ${store.root}` }],
					details: { reviewed, corpusPath: store.root },
				};
			}
			if (scope !== "personal") throw new Error("Promotion source must be a personal corpus");
			if (!params.contributor?.trim()) throw new Error("contributor is required when action=promote");
			const targetNamespace = params.target_namespace ?? namespace;
			const target = new LiteratureStore(
				resolveCorpusRoot(ctx.cwd, "team", targetNamespace, params.target_corpus_root ?? params.corpus_root),
				"team",
				targetNamespace,
			);
			const requested = params.paper_ids
				? await Promise.all(params.paper_ids.map(async (id) => ({ id, record: await store.getPaper(id) })))
				: undefined;
			const missing = requested?.filter((item) => !item.record).map((item) => item.id) ?? [];
			const records = requested
				? requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record))
				: await store.listPapers();
			const contributor = params.contributor.trim();
			let promoted = { promoted: 0, missing };
			if (records.length) {
				const plan = corpusPromotionPlan(store, target, records, contributor);
				const authorization = await requestInteractiveOperationAuthorization(ctx, plan, {
					title: "Propose records to the local team corpus?",
					unavailableMessage: "Team proposals require interactive confirmation before records are copied.",
				});
				promoted = {
					promoted: await runAuthorizedMutation(authorization, plan, () =>
						target.proposePapers(records, contributor),
					),
					missing,
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							"Promoted " +
							promoted.promoted +
							" records to " +
							target.root +
							(promoted.missing.length ? `\nMissing ids: ${promoted.missing.join(", ")}` : ""),
					},
				],
				details: { ...promoted, sourcePath: store.root, targetPath: target.root },
			};
		},
	});
}
