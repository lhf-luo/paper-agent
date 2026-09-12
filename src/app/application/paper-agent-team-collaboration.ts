import type { ConfirmationGrant, OperationPlan } from "../../shared/application/operation-consent.ts";
import {
	executeTeamKnowledgePull,
	previewTeamKnowledgePull,
	teamSnapshotMarkdown,
	type TeamKnowledgePullInput,
} from "../../team/application/team-knowledge-pull.ts";
import type {
	TeamCollaborationChange,
	TeamContentQuery,
	TeamContentRef,
	TeamTopicChange,
} from "../../team/domain/team-corpus-types.ts";
import { TeamCorpusHttpError } from "../../team/application/team-corpus-client.ts";
import { PaperAgentTeamOperations } from "./paper-agent-team-operations.ts";

export abstract class PaperAgentTeamCollaboration extends PaperAgentTeamOperations {
	async listPersonalTeamArtifacts(personalNamespace = this.defaultNamespace, cursor?: string, limit = 50) {
		await this.initialize();
		const store = this.personalStore(personalNamespace);
		await store.initialize();
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
		const offset = Number(cursor ?? 0);
		if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
			throw new Error("Invalid pagination");
		return {
			entries: entries.slice(offset, offset + limit),
			total: entries.length,
			nextCursor: offset + limit < entries.length ? String(offset + limit) : undefined,
		};
	}
	async searchTeamContent(input: TeamContentQuery) {
		const { client, namespace } = await this.configuredTeam();
		return client.searchContent(namespace, input);
	}
	async readTeamContent(ref: TeamContentRef, options: { pending?: boolean; version?: string } = {}) {
		const { client, namespace } = await this.configuredTeam();
		return client.readContent(namespace, ref, options);
	}
	async exportTeamContent(ref: TeamContentRef) {
		const { client, namespace, serverUrl } = await this.configuredTeam();
		return teamSnapshotMarkdown(await client.readContent(namespace, ref), { namespace, serverUrl });
	}
	async teamContributions(options: { mine?: boolean; status?: string; cursor?: string; limit?: number }) {
		const { client, namespace } = await this.configuredTeam();
		return client.contributions(namespace, options);
	}
	async teamDiscussion(ref: TeamContentRef) {
		const { client, namespace } = await this.configuredTeam();
		return client.discussion(namespace, ref);
	}
	async teamReviewers() {
		const { client, namespace } = await this.configuredTeam();
		return client.reviewers(namespace);
	}
	async teamNotifications(cursor?: string, limit?: number) {
		const { client, namespace } = await this.configuredTeam();
		return client.notifications(namespace, cursor, limit);
	}
	async teamTopics(cursor?: string, limit?: number) {
		const { client, namespace } = await this.configuredTeam();
		return client.topics(namespace, cursor, limit);
	}
	private async teamCollaborationPlan(input: TeamCollaborationChange): Promise<OperationPlan> {
		const team = await this.configuredTeam();
		const preview =
			input.action === "assign" || input.action === "comment"
				? await team.client.discussion(team.namespace, input)
				: await team.client.readContent(team.namespace, input, { pending: true });
		if (input.expectedVersion !== preview.version)
			throw new TeamCorpusHttpError(409, "内容或讨论已改变，请重新打开后提交");
		return {
			kind: input.action === "request-changes" ? "team-review" : "team-write",
			summary: `团队协作：${input.action}`,
			targets: [{ label: input.resource, value: input.id, risk: "high" }],
			details: {
				input,
				preview,
				namespace: team.namespace,
				serverUrl: team.serverUrl,
				connectionFingerprint: team.connectionFingerprint,
			},
		};
	}
	async prepareTeamCollaboration(input: TeamCollaborationChange) {
		return this.consent.prepare(await this.teamCollaborationPlan(input));
	}
	async changeTeamCollaboration(input: TeamCollaborationChange, grant: ConfirmationGrant) {
		const plan = await this.teamCollaborationPlan(input);
		await this.consent.consume(grant, plan);
		const { client, namespace } = await this.configuredTeam(plan.details.connectionFingerprint as string);
		return client.changeCollaboration(namespace, input);
	}
	private async teamTopicPlan(input: TeamTopicChange): Promise<OperationPlan> {
		const team = await this.configuredTeam();
		let cursor: string | undefined;
		let current: import("../../team/domain/team-corpus-types.ts").TeamTopic | undefined;
		do {
			const page = await team.client.topics(team.namespace, cursor, 200);
			current = page.entries.find((topic) => topic.id === input.id);
			cursor = page.nextCursor;
		} while (!current && cursor);
		if (current?.version !== input.expectedVersion)
			throw new TeamCorpusHttpError(409, "专题已改变，请刷新后重新提交");
		return {
			kind: "team-write",
			summary: input.delete ? "删除团队专题" : "保存团队专题",
			targets: [{ label: "专题", value: input.id, risk: "high" }],
			details: {
				input,
				current,
				namespace: team.namespace,
				serverUrl: team.serverUrl,
				connectionFingerprint: team.connectionFingerprint,
			},
		};
	}
	async prepareTeamTopic(input: TeamTopicChange) {
		return this.consent.prepare(await this.teamTopicPlan(input));
	}
	async changeTeamTopic(input: TeamTopicChange, grant: ConfirmationGrant) {
		const plan = await this.teamTopicPlan(input);
		await this.consent.consume(grant, plan);
		const { client, namespace } = await this.configuredTeam(plan.details.connectionFingerprint as string);
		return client.changeTopic(namespace, input);
	}
	private async notificationReadPlan(ids: string[]): Promise<OperationPlan> {
		if (!ids.length || ids.length > 200 || ids.some((id) => !/^[a-f0-9-]{36}$/.test(id)))
			throw new Error("Select 1–200 notifications");
		const team = await this.configuredTeam();
		return {
			kind: "team-write",
			summary: `标记 ${ids.length} 条团队通知为已读`,
			targets: ids.map((id) => ({ label: "通知", value: id, risk: "low" })),
			details: { ids, namespace: team.namespace, connectionFingerprint: team.connectionFingerprint },
		};
	}
	async prepareTeamNotificationRead(ids: string[]) {
		return this.consent.prepare(await this.notificationReadPlan(ids));
	}
	async markTeamNotificationsRead(ids: string[], grant: ConfirmationGrant) {
		const plan = await this.notificationReadPlan(ids);
		await this.consent.consume(grant, plan);
		const { client, namespace } = await this.configuredTeam(plan.details.connectionFingerprint as string);
		return client.readNotifications(namespace, ids);
	}
	private async teamKnowledgePullPlan(input: TeamKnowledgePullInput) {
		await this.initialize();
		const team = await this.configuredTeam();
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const store = this.personalStore(personalNamespace);
		await store.initialize();
		const previews = await previewTeamKnowledgePull({ ...team, store, entries: input.entries });
		const plan: OperationPlan = {
			kind: "research-memory-write",
			summary: `将 ${previews.length} 份团队知识快照保存为个人调研笔记`,
			targets: previews.map((entry) => ({ label: entry.title, value: entry.id, risk: "low" })),
			details: {
				personalNamespace,
				previews,
				namespace: team.namespace,
				serverUrl: team.serverUrl,
				connectionFingerprint: team.connectionFingerprint,
			},
		};
		return { plan, previews, store };
	}
	async prepareTeamKnowledgePull(input: TeamKnowledgePullInput) {
		return this.consent.prepare((await this.teamKnowledgePullPlan(input)).plan);
	}
	async pullTeamKnowledge(input: TeamKnowledgePullInput, grant: ConfirmationGrant) {
		const prepared = await this.teamKnowledgePullPlan(input);
		await this.consent.consume(grant, prepared.plan);
		return executeTeamKnowledgePull(prepared.store, prepared.previews);
	}
}
