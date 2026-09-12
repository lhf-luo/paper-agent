import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	TeamCollaborationChange,
	TeamContentRef,
	TeamReviewResource,
	TeamTopicChange,
} from "../../team/domain/team-corpus-types.ts";
import type { PaperAgentApplication } from "../application/paper-agent-application.ts";
import { ApiError, grantFromBody, json, namespaceValue, numberValue, readJson, stringArray } from "./web-http.ts";

function contentRef(body: Record<string, unknown>): TeamContentRef {
	if (
		!["papers", "derived", "artifacts", "pages"].includes(String(body.resource)) ||
		typeof body.id !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.id)
	)
		throw new ApiError(400, "Invalid team content reference");
	return { resource: body.resource as TeamReviewResource, id: body.id };
}

export async function handleTeamContentRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<boolean> {
	const path = url.pathname;
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limit = numberValue(url.searchParams.get("limit"), 50);
	if (request.method === "GET" && path === "/api/team/artifacts/personal") {
		json(
			response,
			200,
			await application.listPersonalTeamArtifacts(namespaceValue(url.searchParams.get("namespace")), cursor, limit),
		);
		return true;
	}
	if (request.method === "GET" && path === "/api/team/content") {
		const resource = url.searchParams.get("resource") ?? undefined;
		if (resource && !["papers", "derived", "artifacts", "pages"].includes(resource))
			throw new ApiError(400, "Invalid team content resource");
		json(
			response,
			200,
			await application.searchTeamContent({
				resource: resource as TeamReviewResource | undefined,
				query: url.searchParams.get("q") ?? undefined,
				pending: url.searchParams.get("pending") === "true",
				topicId: url.searchParams.get("topicId") ?? undefined,
				cursor,
				limit,
			}),
		);
		return true;
	}
	const item = /^\/api\/team\/(content|content-export|discussions)\/([^/]+)\/([^/]+)$/.exec(path);
	if (request.method === "GET" && item) {
		const ref = contentRef({ resource: item[2], id: decodeURIComponent(item[3]) });
		if (item[1] === "content-export") {
			const body = await application.exportTeamContent(ref);
			response.writeHead(200, {
				"content-type": "text/markdown; charset=utf-8",
				"content-disposition": `attachment; filename="team-${ref.resource}-${ref.id}.md"`,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			response.end(body);
		} else
			json(
				response,
				200,
				item[1] === "content"
					? await application.readTeamContent(ref, {
							pending: url.searchParams.get("pending") === "true",
							version: url.searchParams.get("version") ?? undefined,
						})
					: await application.teamDiscussion(ref),
			);
		return true;
	}
	if (request.method === "GET" && path === "/api/team/contributions") {
		json(
			response,
			200,
			await application.teamContributions({
				mine: url.searchParams.get("mine") === "true",
				status: url.searchParams.get("status") ?? undefined,
				cursor,
				limit,
			}),
		);
		return true;
	}
	if (request.method === "GET" && path === "/api/team/reviewers") {
		json(response, 200, await application.teamReviewers());
		return true;
	}
	if (request.method === "GET" && path === "/api/team/notifications") {
		json(response, 200, await application.teamNotifications(cursor, limit));
		return true;
	}
	if (request.method === "GET" && path === "/api/team/topics") {
		json(response, 200, await application.teamTopics(cursor, limit));
		return true;
	}
	const operation = /^\/api\/team\/(collaboration|topics|knowledge-pull|notifications\/read)\/(prepare|execute)$/.exec(
		path,
	);
	if (request.method === "POST" && operation) {
		const body = await readJson(request);
		const prepare = operation[2] === "prepare";
		let result: unknown;
		if (operation[1] === "collaboration") {
			if (
				!["comment", "assign", "request-changes", "withdraw"].includes(String(body.action)) ||
				typeof body.expectedVersion !== "string"
			)
				throw new ApiError(400, "Invalid collaboration change or missing version");
			const input: TeamCollaborationChange = {
				...contentRef(body),
				action: body.action as TeamCollaborationChange["action"],
				expectedVersion: body.expectedVersion,
				text: typeof body.text === "string" ? body.text : undefined,
				assigneeId:
					body.assigneeId === null ? null : typeof body.assigneeId === "string" ? body.assigneeId : undefined,
			};
			result = prepare
				? await application.prepareTeamCollaboration(input)
				: await application.changeTeamCollaboration(input, grantFromBody(body));
		} else if (operation[1] === "topics") {
			if (typeof body.id !== "string" || (body.entries !== undefined && !Array.isArray(body.entries)))
				throw new ApiError(400, "Invalid topic change");
			const input: TeamTopicChange = {
				id: body.id,
				title: typeof body.title === "string" ? body.title : undefined,
				description: typeof body.description === "string" ? body.description : undefined,
				entries: body.entries?.map(contentRef),
				delete: body.delete === true,
				expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
			};
			result = prepare
				? await application.prepareTeamTopic(input)
				: await application.changeTeamTopic(input, grantFromBody(body));
		} else if (operation[1] === "notifications/read") {
			const ids = stringArray(body.ids) ?? [];
			result = prepare
				? await application.prepareTeamNotificationRead(ids)
				: await application.markTeamNotificationsRead(ids, grantFromBody(body));
		} else {
			if (!Array.isArray(body.entries)) throw new ApiError(400, "Knowledge entries are required");
			const input = {
				entries: body.entries.map(contentRef),
				personalNamespace: namespaceValue(body.personalNamespace),
			};
			result = prepare
				? await application.prepareTeamKnowledgePull(input)
				: await application.pullTeamKnowledge(input, grantFromBody(body));
		}
		json(response, 200, result);
		return true;
	}
	return false;
}
