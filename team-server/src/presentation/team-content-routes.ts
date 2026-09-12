import type { IncomingMessage, ServerResponse } from "node:http";
import { pageOf, TeamContentService } from "../application/team-content-service.ts";
import { canAccessTeamNamespace } from "../domain/team-identity.ts";
import { TeamStateError } from "../domain/team-state-error.ts";
import type { TeamKnowledgeStore } from "../infrastructure/team-knowledge-store.ts";
import type { TeamIdentity, TeamTokenRegistry } from "../infrastructure/team-token-registry.ts";
import type {
	TeamCollaborationChange,
	TeamContentRef,
	TeamReviewResource,
	TeamTopicChange,
} from "../protocol/team-corpus-types.ts";
import { json, objectBody, permits, readJsonBody } from "./team-corpus-http.ts";

function segment(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
		throw new TeamStateError(400, `Invalid ${label}`);
	return value;
}
function resource(value: unknown): TeamReviewResource {
	if (value !== "papers" && value !== "pages" && value !== "derived" && value !== "artifacts")
		throw new TeamStateError(400, "Invalid content resource");
	return value;
}
function ref(value: Record<string, unknown>): TeamContentRef {
	return { resource: resource(value.resource), id: segment(value.id, "content id") };
}
function requiredVersion(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		throw new TeamStateError(428, "The displayed version is required");
	return value;
}
function textField(value: unknown, max: number, required = false): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.trim().length > max || (required && !value.trim()))
		throw new TeamStateError(400, `Text must contain ${required ? "1" : "0"}–${max} characters`);
	return value.trim();
}

export async function handleTeamContentRoutes(input: {
	request: IncomingMessage;
	response: ServerResponse;
	url: URL;
	resourcePath: string;
	namespace: string;
	identity: TeamIdentity;
	registry: TeamTokenRegistry;
	store: TeamKnowledgeStore;
	maxBodyBytes: number;
}): Promise<boolean> {
	const { request, response, url, resourcePath: path, namespace, identity, registry, store, maxBodyBytes } = input;
	const service = new TeamContentService(store);
	const viewer = {
		actor: { id: identity.id, name: identity.name },
		canRead: permits(identity, "reader"),
		canContribute: permits(identity, "contributor"),
		canReview: permits(identity, "reviewer"),
	};
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
	const reviewers = async () =>
		(await registry.list())
			.filter(
				(member) =>
					!member.revokedAt &&
					!member.bannedAt &&
					(!member.expiresAt || Date.parse(member.expiresAt) > Date.now()) &&
					canAccessTeamNamespace(member, namespace) &&
					(member.roles.includes("reviewer") || member.roles.includes("admin")),
			)
			.map((member) => ({ id: member.id, name: member.name }));
	if (request.method === "GET" && path === "content") {
		json(
			response,
			200,
			await service.search(
				{
					resource: url.searchParams.has("resource") ? resource(url.searchParams.get("resource")) : undefined,
					query: textField(url.searchParams.get("q") ?? undefined, 2000),
					pending: url.searchParams.get("pending") === "true",
					topicId: url.searchParams.has("topicId")
						? segment(url.searchParams.get("topicId"), "topic id")
						: undefined,
					cursor,
					limit,
				},
				viewer,
			),
		);
		return true;
	}
	const content = /^(content|discussions)\/([^/]+)\/([^/]+)$/.exec(path);
	if (request.method === "GET" && content) {
		const target = ref({ resource: content[2], id: decodeURIComponent(content[3]) });
		json(
			response,
			200,
			content[1] === "content"
				? await service.read(
						target,
						viewer,
						url.searchParams.get("pending") === "true",
						url.searchParams.get("version") ?? undefined,
					)
				: await service.discussion(target, viewer),
		);
		return true;
	}
	if (request.method === "GET" && path === "contributions") {
		json(
			response,
			200,
			await service.proposals(viewer, {
				mine: url.searchParams.get("mine") === "true",
				status: url.searchParams.get("status") ?? undefined,
				cursor,
				limit,
			}),
		);
		return true;
	}
	if (request.method === "GET" && path === "reviewers") {
		if (!viewer.canReview && !viewer.canContribute)
			throw new TeamStateError(403, "Contributor or reviewer role required");
		json(response, 200, { entries: await reviewers() });
		return true;
	}
	if (request.method === "POST" && path === "collaboration") {
		const body = objectBody(await readJsonBody(request, maxBodyBytes), "Expected a collaboration change");
		if (!["comment", "assign", "request-changes", "withdraw"].includes(String(body.action)))
			throw new TeamStateError(400, "Invalid collaboration action");
		const change: TeamCollaborationChange = {
			...ref(body),
			action: body.action as TeamCollaborationChange["action"],
			expectedVersion: requiredVersion(body.expectedVersion),
			text: textField(body.text, 10_000, body.action === "comment" || body.action === "request-changes"),
			assigneeId:
				body.assigneeId === null
					? null
					: body.assigneeId === undefined
						? undefined
						: segment(body.assigneeId, "assignee id"),
		};
		let assignee: { id: string; name: string } | null | undefined;
		if (change.action === "assign") {
			if (!viewer.canReview) throw new TeamStateError(403, "reviewer role required");
			if (change.assigneeId === undefined)
				throw new TeamStateError(400, "assigneeId is required (null clears assignment)");
			assignee =
				change.assigneeId === null ? null : (await reviewers()).find((member) => member.id === change.assigneeId);
			if (assignee === undefined)
				throw new TeamStateError(400, "Assignee must be an active reviewer in this namespace");
		}
		json(response, 200, await service.change(change, viewer, assignee));
		return true;
	}
	if (request.method === "GET" && path === "notifications") {
		const entries = await store.withWriteOperation(() => store.collaboration.notifications(viewer.actor), false);
		json(response, 200, {
			...pageOf(entries, cursor, limit),
			unread: entries.filter((entry) => !entry.readAt).length,
		});
		return true;
	}
	if (request.method === "POST" && path === "notifications/read") {
		const body = objectBody(await readJsonBody(request, maxBodyBytes), "Expected notification ids");
		if (
			!Array.isArray(body.ids) ||
			body.ids.length < 1 ||
			body.ids.length > 200 ||
			body.ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
		)
			throw new TeamStateError(400, "Select 1–200 notifications");
		const ids = [...new Set(body.ids as string[])];
		await store.withWriteOperation(async () => {
			await store.collaboration.readNotifications(viewer.actor, ids);
			await store.appendAudit(viewer.actor, "notifications.read", undefined, { count: ids.length });
		});
		json(response, 200, { read: ids.length });
		return true;
	}
	if (request.method === "GET" && path === "topics") {
		json(response, 200, await service.topics(viewer, cursor, limit));
		return true;
	}
	if (request.method === "POST" && path === "topics") {
		if (!viewer.canReview) throw new TeamStateError(403, "reviewer role required");
		const body = objectBody(await readJsonBody(request, maxBodyBytes), "Expected a topic change");
		if (body.entries !== undefined && (!Array.isArray(body.entries) || body.entries.length > 1000))
			throw new TeamStateError(400, "Topics support up to 1000 entries");
		const entries = (body.entries as unknown[] | undefined)?.map((entry) =>
			ref(objectBody(entry, "Expected a content reference")),
		);
		const change: TeamTopicChange = {
			id: segment(body.id, "topic id"),
			delete: body.delete === true,
			expectedVersion: body.expectedVersion === undefined ? undefined : requiredVersion(body.expectedVersion),
			title: textField(body.title, 200, body.delete !== true),
			description: textField(body.description, 2000),
			entries: entries?.filter(
				(entry, index) =>
					entries.findIndex((other) => other.id === entry.id && other.resource === entry.resource) === index,
			),
		};
		json(response, 200, await service.changeTopic(change, viewer));
		return true;
	}
	return false;
}
