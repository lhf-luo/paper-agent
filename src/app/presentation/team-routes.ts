import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TeamAccessChange, TeamMemberChange } from "../../team/application/team-access-service.ts";
import { TeamCorpusHttpError } from "../../team/application/team-corpus-client.ts";
import type {
	PaperAgentApplication,
	TeamArtifactProposalInput,
	TeamBlobUploadInput,
	TeamDerivedProposalInput,
	TeamPagesProposalInput,
	TeamPullInput,
	TeamRestoreDrillInput,
	TeamReviewInput,
	TeamWithdrawInput,
} from "../application/paper-agent-application.ts";
import { handleTeamContentRoutes } from "./team-content-routes.ts";
import { ApiError, grantFromBody, json, namespaceValue, numberValue, readJson, stringArray } from "./web-http.ts";

export async function handleTeamRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	try {
		await handleRoutes(application, request, response, url);
	} catch (error) {
		if (error instanceof TeamCorpusHttpError) throw new ApiError(error.status, error.message);
		throw error;
	}
}

async function handleRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	if (await handleTeamContentRoutes(application, request, response, url)) return;
	if (request.method === "GET" && url.pathname === "/api/team/access") {
		json(response, 200, await application.teamAccess.status());
		return;
	}
	if (request.method === "POST" && /^\/api\/team\/(access|identities)\/(prepare|execute)$/.test(url.pathname)) {
		const body = await readJson(request);
		const result = url.pathname.endsWith("/execute")
			? await application.teamAccess.execute(grantFromBody(body))
			: url.pathname.includes("/access/")
				? await application.teamAccess.prepareAccess(body as TeamAccessChange)
				: await application.teamAccess.prepareMember(body as unknown as TeamMemberChange);
		json(response, 200, result);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/team/overview") {
		json(response, 200, await application.teamOverview());
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/team/proposals") {
		json(
			response,
			200,
			await application.listPendingTeamPapers(
				url.searchParams.get("cursor") ?? undefined,
				numberValue(url.searchParams.get("limit"), 10),
			),
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/team/search") {
		const openAccessParam = url.searchParams.get("openAccess");
		json(
			response,
			200,
			await application.searchTeamLibrary({
				query: url.searchParams.get("q") ?? undefined,
				yearFrom: numberValue(url.searchParams.get("yearFrom")),
				yearTo: numberValue(url.searchParams.get("yearTo")),
				authors: url.searchParams.getAll("author").filter(Boolean),
				venues: url.searchParams.getAll("venue").filter(Boolean),
				types: url.searchParams.getAll("type").filter(Boolean),
				statuses: url.searchParams.getAll("status").filter(Boolean) as any,
				openAccess: openAccessParam === "true" ? true : openAccessParam === "false" ? false : undefined,
				topicIds: url.searchParams
					.getAll("topic")
					.flatMap((value) => value.split(","))
					.map((value) => value.trim())
					.filter(Boolean),
				limit: numberValue(url.searchParams.get("limit"), 100),
				cursor: url.searchParams.get("cursor") ?? undefined,
			}),
		);
		return;
	}
	if (request.method === "GET" && url.pathname.startsWith("/api/team/papers/")) {
		const paperId = decodeURIComponent(url.pathname.slice("/api/team/papers/".length));
		json(response, 200, await application.getTeamPaper(paperId));
		return;
	}
	if (request.method === "GET" && /^\/api\/team\/blobs\/[a-f0-9]{64}$/.test(url.pathname)) {
		const blob = await application.openTeamBlob(url.pathname.split("/").at(-1)!);
		if (!blob.body) throw new ApiError(502, "Team attachment has no response body");
		response.writeHead(200, {
			"content-type": blob.headers.get("content-type") ?? "application/octet-stream",
			"content-disposition": blob.headers.get("content-disposition") ?? "attachment",
			...(blob.headers.has("content-length") ? { "content-length": blob.headers.get("content-length")! } : {}),
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		});
		await pipeline(Readable.fromWeb(blob.body as import("node:stream/web").ReadableStream<Uint8Array>), response);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/pull/prepare" || url.pathname === "/api/team/pull/execute")
	) {
		const body = await readJson(request);
		const input: TeamPullInput = {
			paperIds: stringArray(body.paperIds) ?? [],
			personalNamespace: namespaceValue(body.personalNamespace),
			includePdf: body.includePdf === true,
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamPull(input)
				: await application.pullTeamPapers(input, grantFromBody(body)),
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/team/derived/personal") {
		json(
			response,
			200,
			await application.listPersonalDerived(
				namespaceValue(url.searchParams.get("namespace")) ?? application.defaultNamespace,
			),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/derived/prepare" || url.pathname === "/api/team/derived/execute")
	) {
		const body = await readJson(request);
		const input: TeamDerivedProposalInput = {
			keys: stringArray(body.keys) ?? [],
			personalNamespace: namespaceValue(body.personalNamespace),
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamDerivedProposal(input)
				: await application.proposeTeamDerived(input, grantFromBody(body)),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/pages/prepare" || url.pathname === "/api/team/pages/execute")
	) {
		const body = await readJson(request);
		if (
			!Array.isArray(body.sources) ||
			body.sources.length < 1 ||
			body.sources.length > 200 ||
			body.sources.some(
				(entry) =>
					!entry ||
					typeof entry !== "object" ||
					!["note", "wiki"].includes(entry.kind) ||
					typeof entry.id !== "string" ||
					!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id),
			)
		) {
			throw new ApiError(400, "sources must contain 1–200 explicit note/wiki source ids");
		}
		const sources = body.sources.map((entry) => ({ kind: entry.kind as "note" | "wiki", id: entry.id as string }));
		const input: TeamPagesProposalInput = {
			sources,
			personalNamespace: namespaceValue(body.personalNamespace),
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamPagesProposal(input)
				: await application.proposeTeamPages(input, grantFromBody(body)),
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/team/pages/personal") {
		const namespace = namespaceValue(url.searchParams.get("namespace")) ?? application.defaultNamespace;
		const [notes, wiki] = await Promise.all([
			application.listResearchNotes(namespace),
			application.listWikiPages(namespace),
		]);
		json(response, 200, {
			notes,
			wikiPages: wiki.pages.slice(0, 200),
		});
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/proposals/withdraw/prepare" ||
			url.pathname === "/api/team/proposals/withdraw/execute")
	) {
		const body = await readJson(request);
		const input: TeamWithdrawInput = { paperIds: stringArray(body.paperIds) ?? [] };
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamWithdraw(input)
				: await application.withdrawTeamProposals(input, grantFromBody(body)),
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/team/proposals/prepare") {
		const body = await readJson(request);
		json(
			response,
			200,
			await application.prepareTeamPaperProposal({
				paperIds: stringArray(body.paperIds) ?? [],
				personalNamespace: typeof body.personalNamespace === "string" ? body.personalNamespace : undefined,
				topicIds: stringArray(body.topicIds),
			}),
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/team/proposals/execute") {
		const body = await readJson(request);
		json(
			response,
			200,
			await application.proposeTeamPapers(
				{
					paperIds: stringArray(body.paperIds) ?? [],
					personalNamespace: typeof body.personalNamespace === "string" ? body.personalNamespace : undefined,
					topicIds: stringArray(body.topicIds),
				},
				grantFromBody(body),
			),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/artifacts/prepare" || url.pathname === "/api/team/artifacts/execute")
	) {
		const body = await readJson(request);
		if (
			(typeof body.artifactJobId !== "string" && typeof body.manifestSha256 !== "string") ||
			typeof body.paperId !== "string"
		) {
			throw new ApiError(400, "paperId and an artifactJobId or manifestSha256 are required");
		}
		const input: TeamArtifactProposalInput = {
			artifactJobId: typeof body.artifactJobId === "string" ? body.artifactJobId : undefined,
			manifestSha256: typeof body.manifestSha256 === "string" ? body.manifestSha256 : undefined,
			paperId: body.paperId,
			personalNamespace: namespaceValue(body.personalNamespace),
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamArtifactProposal(input)
				: await application.proposeTeamArtifact(input, grantFromBody(body)),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/blobs/prepare" || url.pathname === "/api/team/blobs/execute")
	) {
		const body = await readJson(request);
		if (typeof body.paperId !== "string" || typeof body.sha256 !== "string") {
			throw new ApiError(400, "paperId and sha256 are required");
		}
		const input: TeamBlobUploadInput = {
			paperId: body.paperId,
			sha256: body.sha256,
			personalNamespace: namespaceValue(body.personalNamespace),
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamBlobUpload(input)
				: await application.uploadTeamBlob(input, grantFromBody(body)),
		);
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/reviews/prepare" || url.pathname === "/api/team/reviews/execute")
	) {
		const body = await readJson(request);
		if (!["papers", "derived", "artifacts", "pages"].includes(String(body.resource)))
			throw new ApiError(400, "resource must be papers, derived, artifacts, or pages");
		if (body.decision !== "team-approved" && body.decision !== "team-rejected")
			throw new ApiError(400, "decision must be team-approved or team-rejected");
		const input: TeamReviewInput = {
			resource: body.resource as TeamReviewInput["resource"],
			ids: stringArray(body.ids) ?? [],
			decision: body.decision,
			reason: typeof body.reason === "string" ? body.reason : undefined,
			expectedVersions:
				body.expectedVersions && typeof body.expectedVersions === "object" && !Array.isArray(body.expectedVersions)
					? (body.expectedVersions as Record<string, string>)
					: undefined,
		};
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamReview(input)
				: await application.reviewTeamEntries(input, grantFromBody(body)),
		);
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/team/backup/prepare") {
		json(response, 200, await application.prepareTeamBackup());
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/team/backup/execute") {
		json(response, 200, await application.backupTeam(grantFromBody(await readJson(request))));
		return;
	}
	if (
		request.method === "POST" &&
		(url.pathname === "/api/team/restore-drill/prepare" || url.pathname === "/api/team/restore-drill/execute")
	) {
		const body = await readJson(request);
		if (typeof body.backupPath !== "string") throw new ApiError(400, "backupPath is required");
		const input: TeamRestoreDrillInput = { backupPath: body.backupPath };
		json(
			response,
			200,
			url.pathname.endsWith("/prepare")
				? await application.prepareTeamRestoreDrill(input)
				: await application.drillTeamRestore(input, grantFromBody(body)),
		);
		return;
	}
	throw new ApiError(404, "Team API route not found");
}
