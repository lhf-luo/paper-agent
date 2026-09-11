import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	PaperAgentApplication,
	TeamArtifactProposalInput,
	TeamBlobUploadInput,
	TeamDerivedProposalInput,
	TeamPullInput,
	TeamRestoreDrillInput,
	TeamReviewInput,
	TeamWithdrawInput,
} from "../application/paper-agent-application.ts";
import { ApiError, grantFromBody, json, namespaceValue, numberValue, readJson, stringArray } from "./web-http.ts";
import type { TeamAccessChange, TeamMemberChange } from "../../team/application/team-access-service.ts";

export async function handleTeamRoutes(
	application: PaperAgentApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	if (request.method === "GET" && url.pathname === "/api/team/access") {
		json(response, 200, await application.teamAccess.status());
		return;
	}
	if (request.method === "POST" && /^\/api\/team\/(access|identities)\/(prepare|execute)$/.test(url.pathname)) {
		const body = await readJson(request);
		const result = url.pathname.endsWith("/execute") ? await application.teamAccess.execute(grantFromBody(body)) :
			url.pathname.includes("/access/") ? await application.teamAccess.prepareAccess(body as TeamAccessChange) :
			await application.teamAccess.prepareMember(body as unknown as TeamMemberChange);
		json(response, 200, result);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/team/overview") {
		json(response, 200, await application.teamOverview());
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/team/search") {
		json(
			response,
			200,
			await application.searchTeamLibrary({
				query: url.searchParams.get("q") ?? undefined,
				yearFrom: numberValue(url.searchParams.get("yearFrom")),
				yearTo: numberValue(url.searchParams.get("yearTo")),
				limit: numberValue(url.searchParams.get("limit"), 100),
				cursor: url.searchParams.get("cursor") ?? undefined,
			}),
		);
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
		if (typeof body.artifactJobId !== "string" || typeof body.paperId !== "string") {
			throw new ApiError(400, "artifactJobId and paperId are required");
		}
		const input: TeamArtifactProposalInput = {
			artifactJobId: body.artifactJobId,
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
		if (!["papers", "derived", "artifacts"].includes(String(body.resource)))
			throw new ApiError(400, "resource must be papers, derived, or artifacts");
		if (body.decision !== "team-approved" && body.decision !== "team-rejected")
			throw new ApiError(400, "decision must be team-approved or team-rejected");
		const input: TeamReviewInput = {
			resource: body.resource as TeamReviewInput["resource"],
			ids: stringArray(body.ids) ?? [],
			decision: body.decision,
			reason: typeof body.reason === "string" ? body.reason : undefined,
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
