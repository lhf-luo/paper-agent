import { LiteratureStore, resolveCorpusRoot } from "../../literature/application/literature-store.ts";
import type { OperationPlan } from "../../shared/application/operation-consent.ts";
import { executeTeamKnowledgePull, previewTeamKnowledgePull } from "../application/team-knowledge-pull.ts";
import { sanitizeArtifactManifestForTeamProposal, type TeamCorpusClient } from "../application/team-corpus-client.ts";
import type { TeamCollaborationChange, TeamReviewResource, TeamTopicChange } from "../domain/team-corpus-types.ts";

export interface TeamCollaborationToolParams {
	action: string;
	query?: string;
	review_resource?: TeamReviewResource;
	entry_ids?: string[];
	paper_ids?: string[];
	cursor?: string;
	limit?: number;
	mine?: boolean;
	pending?: boolean;
	proposal_status?: string;
	review_reason?: string;
	comment?: string;
	assignee_id?: string | null;
	expected_version?: string;
	notification_ids?: string[];
	topic_id?: string;
	topic_title?: string;
	topic_description?: string;
	topic_entries?: Array<{ resource: TeamReviewResource; id: string }>;
	personal_namespace?: string;
	personal_corpus_root?: string;
	sha256?: string;
	backup_path?: string;
}

export async function handleTeamCollaborationTool(
	params: TeamCollaborationToolParams,
	client: TeamCorpusClient,
	namespace: string,
	cwd: string,
	authorize: (plan: OperationPlan) => Promise<void>,
) {
	const reply = (value: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: value,
	});
	const id = () => {
		const ids = params.entry_ids ?? params.paper_ids;
		if (ids?.length !== 1) throw new Error("This action requires exactly one entry_id");
		return ids[0];
	};
	const ref = () => ({ resource: params.review_resource ?? "papers", id: id() });
	const targetStore = async () => {
		const personalNamespace = params.personal_namespace ?? "default";
		const store = new LiteratureStore(
			resolveCorpusRoot(cwd, "personal", personalNamespace, params.personal_corpus_root),
			"personal",
			personalNamespace,
		);
		await store.initialize();
		return { store, personalNamespace };
	};
	if (params.action === "search_content")
		return reply(
			await client.searchContent(namespace, {
				resource: params.review_resource,
				query: params.query,
				pending: params.pending,
				topicId: params.topic_id,
				cursor: params.cursor,
				limit: Math.min(params.limit ?? 50, 200),
			}),
		);
	if (params.action === "read_content")
		return reply(
			await client.readContent(namespace, ref(), { pending: params.pending, version: params.expected_version }),
		);
	if (params.action === "contributions")
		return reply(
			await client.contributions(namespace, {
				mine: params.mine ?? true,
				status: params.proposal_status,
				cursor: params.cursor,
				limit: Math.min(params.limit ?? 50, 200),
			}),
		);
	if (params.action === "discussion") return reply(await client.discussion(namespace, ref()));
	if (params.action === "reviewers") return reply(await client.reviewers(namespace));
	if (params.action === "notifications")
		return reply(await client.notifications(namespace, params.cursor, Math.min(params.limit ?? 50, 200)));
	if (params.action === "topics")
		return reply(await client.topics(namespace, params.cursor, Math.min(params.limit ?? 50, 200)));
	if (["comment", "assign", "request_changes", "withdraw"].includes(params.action)) {
		const target = ref();
		const preview =
			params.action === "comment" || params.action === "assign"
				? await client.discussion(namespace, target)
				: await client.readContent(namespace, target, { pending: true });
		if (params.expected_version && params.expected_version !== preview.version)
			throw new Error("Team content or discussion changed; read the current version again");
		const input: TeamCollaborationChange = {
			...target,
			action:
				params.action === "request_changes"
					? "request-changes"
					: (params.action as TeamCollaborationChange["action"]),
			expectedVersion: preview.version,
			text: params.comment ?? params.review_reason,
			assigneeId: params.assignee_id,
		};
		if ((input.action === "comment" || input.action === "request-changes") && !input.text?.trim())
			throw new Error("A comment or review_reason is required");
		await authorize({
			kind: input.action === "request-changes" ? "team-review" : "team-write",
			summary: `Team proposal: ${input.action}`,
			targets: [{ label: target.resource, value: target.id, risk: "high" }],
			details: { namespace, input, preview },
		});
		return reply(await client.changeCollaboration(namespace, input));
	}
	if (params.action === "read_notifications") {
		const ids = params.notification_ids ?? [];
		if (!ids.length || ids.length > 200) throw new Error("Select 1–200 notification_ids");
		await authorize({
			kind: "team-write",
			summary: `Mark ${ids.length} team notifications read`,
			targets: ids.map((value) => ({ label: "Notification", value, risk: "low" })),
			details: { namespace, ids },
		});
		return reply(await client.readNotifications(namespace, ids));
	}
	if (params.action === "save_topic" || params.action === "delete_topic") {
		if (!params.topic_id) throw new Error("topic_id is required");
		const input: TeamTopicChange = {
			id: params.topic_id,
			title: params.topic_title,
			description: params.topic_description,
			entries: params.topic_entries,
			delete: params.action === "delete_topic",
			expectedVersion: params.expected_version,
		};
		if (!input.delete && !input.title?.trim()) throw new Error("topic_title is required");
		await authorize({
			kind: "team-write",
			summary: `${input.delete ? "Delete" : "Save"} team topic`,
			targets: [{ label: input.title ?? input.id, value: input.id, risk: "high" }],
			details: { namespace, input },
		});
		return reply(await client.changeTopic(namespace, input));
	}
	if (params.action === "pull_knowledge") {
		const resource = params.review_resource;
		if (!resource || resource === "papers" || !params.entry_ids?.length)
			throw new Error("pull_knowledge requires a non-paper review_resource and entry_ids");
		const { store, personalNamespace } = await targetStore();
		const previews = await previewTeamKnowledgePull({
			client,
			namespace,
			serverUrl: client.baseUrl.origin,
			store,
			entries: params.entry_ids.map((entryId) => ({ resource, id: entryId })),
		});
		await authorize({
			kind: "research-memory-write",
			summary: `Save ${previews.length} team snapshots as personal research notes`,
			targets: previews.map((entry) => ({ label: entry.title, value: entry.id, risk: "low" })),
			details: { namespace, personalNamespace, previews },
		});
		return reply(await executeTeamKnowledgePull(store, previews));
	}
	if (params.action === "personal_artifacts" || params.action === "propose_artifact") {
		const { store, personalNamespace } = await targetStore();
		if (params.action === "personal_artifacts") {
			const entries = [];
			for (const paper of await store.listPapers())
				for (const manifest of await store.listArtifactManifests(paper.id))
					entries.push({
						paperId: paper.id,
						title: paper.title,
						pdfSha256: manifest.pdfSha256,
						discoveredAt: manifest.discoveredAt,
						candidates: manifest.candidates.length,
						acquisitions: manifest.acquisitions.length,
					});
			const offset = Number(params.cursor ?? 0),
				limit = Math.min(params.limit ?? 50, 200);
			return reply({
				entries: entries.slice(offset, offset + limit),
				nextCursor: offset + limit < entries.length ? String(offset + limit) : undefined,
			});
		}
		const paperId = id();
		const candidates = (await store.listArtifactManifests(paperId)).filter(
			(entry) => !params.sha256 || entry.pdfSha256 === params.sha256,
		);
		if (candidates.length !== 1)
			throw new Error("Select one saved artifact manifest using personal_artifacts and sha256");
		const manifest = sanitizeArtifactManifestForTeamProposal(candidates[0]);
		await authorize({
			kind: "team-proposal",
			summary: "Propose a saved artifact manifest",
			targets: [{ label: "Artifact manifest", value: paperId, risk: "high" }],
			details: { namespace, personalNamespace, manifest },
		});
		return reply(await client.proposeArtifact(namespace, paperId, manifest));
	}
	if (params.action === "upload_blob") {
		const { store } = await targetStore();
		const paperId = id();
		const versions = await store.listPaperVersions(paperId);
		const version = params.sha256
			? versions.find((entry) => entry.sha256 === params.sha256)
			: (versions.find((entry) => entry.isPreferred) ?? versions[0]);
		if (!version) throw new Error("Selected personal PDF version does not exist");
		const { blobPath, ...publicVersion } = version;
		await authorize({
			kind: "team-proposal",
			summary: "Upload a personal PDF to the team review queue",
			targets: [{ label: "PDF", value: `${paperId}/${version.sha256}`, risk: "high" }],
			details: { namespace, version: publicVersion },
		});
		return reply(await client.uploadBlobFile(namespace, version.sha256, blobPath, publicVersion));
	}
	if (params.action === "restore_drill") {
		if (!params.backup_path) throw new Error("backup_path is required");
		await authorize({
			kind: "backup-restore",
			summary: "Validate a team backup in an isolated restore directory",
			targets: [{ label: "Backup", value: params.backup_path, risk: "high" }],
			details: { namespace },
		});
		return reply(await client.restoreDrill(namespace, params.backup_path));
	}
	return undefined;
}
