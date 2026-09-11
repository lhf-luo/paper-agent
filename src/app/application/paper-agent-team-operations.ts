import { createHash } from "node:crypto";
import type { ArtifactManifest, PaperRecord } from "../../literature/domain/literature-types.ts";
import type {
	ConfirmationGrant,
	OperationPlan,
	PreparedOperation,
} from "../../shared/application/operation-consent.ts";
import { sanitizePaperRecordForTeamProposal } from "../../team/application/team-corpus-client.ts";

import type {
	TeamArtifactProposalInput,
	TeamBlobUploadInput,
	TeamPaperProposalInput,
	TeamRestoreDrillInput,
	TeamReviewInput,
} from "./paper-agent-contracts.ts";
import { PaperAgentTeamAccess } from "./paper-agent-team-access.ts";

export abstract class PaperAgentTeamOperations extends PaperAgentTeamAccess {
	protected async teamPaperProposalPlan(
		input: TeamPaperProposalInput,
	): Promise<{ records: PaperRecord[]; plan: OperationPlan }> {
		if (!input.paperIds.length || input.paperIds.length > 500)
			throw new Error("Select between 1 and 500 personal papers");
		const namespace = input.personalNamespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const requested = await Promise.all(input.paperIds.map(async (id) => ({ id, record: await store.getPaper(id) })));
		const missing = requested.filter((item) => !item.record).map((item) => item.id);
		if (missing.length) throw new Error(`Personal corpus does not contain: ${missing.join(", ")}`);
		const records = requested
			.map((item) => item.record)
			.filter((record): record is PaperRecord => Boolean(record))
			.map(sanitizePaperRecordForTeamProposal);
		const team = await this.configuredTeam();
		const preview = records;
		return {
			records,
			plan: {
				kind: "team-proposal",
				summary: `Propose ${records.length} personal paper record(s) to the team knowledge base`,
				actor: "local-user",
				targets: records.map((record) => ({
					label: record.title.slice(0, 120),
					value: record.id,
					risk: "medium" as const,
				})),
				details: {
					serverUrl: team.serverUrl,
					teamNamespace: team.namespace,
					personalNamespace: namespace,
					privacy: "Personal notes and screening decisions are removed; tags and source provenance remain.",
					preview,
				},
			},
		};
	}

	async prepareTeamPaperProposal(input: TeamPaperProposalInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamPaperProposalPlan(input)).plan);
	}

	async proposeTeamPapers(input: TeamPaperProposalInput, grant: ConfirmationGrant) {
		const prepared = await this.teamPaperProposalPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam();
		return client.proposePapers(namespace, prepared.records);
	}

	protected async teamReviewPlan(input: TeamReviewInput): Promise<OperationPlan> {
		if (!input.ids.length || input.ids.length > 500) throw new Error("Select between 1 and 500 team entries");
		if (input.reason && input.reason.length > 10_000) throw new Error("Review reason is too long");
		const team = await this.configuredTeam();
		return {
			kind: "team-review",
			summary: `${input.decision === "team-approved" ? "Approve" : "Reject"} ${input.ids.length} team ${input.resource} entr${input.ids.length === 1 ? "y" : "ies"}`,
			actor: "local-user",
			targets: input.ids.map((id) => ({ label: input.resource, value: id, risk: "high" as const })),
			details: { serverUrl: team.serverUrl, namespace: team.namespace, ...input },
		};
	}

	async prepareTeamReview(input: TeamReviewInput): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamReviewPlan(input));
	}

	async reviewTeamEntries(input: TeamReviewInput, grant: ConfirmationGrant) {
		await this.consent.consume(grant, await this.teamReviewPlan(input));
		const { client, namespace } = await this.configuredTeam();
		if (input.resource === "papers") return client.reviewPapers(namespace, input.ids, input.decision, input.reason);
		if (input.resource === "derived") return client.reviewDerived(namespace, input.ids, input.decision, input.reason);
		return client.reviewArtifacts(namespace, input.ids, input.decision, input.reason);
	}

	protected async teamBackupPlan(): Promise<OperationPlan> {
		const team = await this.configuredTeam();
		return {
			kind: "backup-restore",
			summary: "Create a server-side backup of the team knowledge namespace",
			actor: "local-user",
			targets: [{ label: "Team namespace", value: `${team.serverUrl}/${team.namespace}`, risk: "medium" }],
			details: { action: "backup", serverUrl: team.serverUrl, namespace: team.namespace },
		};
	}

	async prepareTeamBackup(): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamBackupPlan());
	}

	async backupTeam(grant: ConfirmationGrant) {
		await this.consent.consume(grant, await this.teamBackupPlan());
		const { client, namespace } = await this.configuredTeam();
		return client.backup(namespace);
	}

	protected async teamRestoreDrillPlan(input: TeamRestoreDrillInput): Promise<OperationPlan> {
		if (typeof input.backupPath !== "string" || !input.backupPath.trim() || input.backupPath.length > 4_000) {
			throw new Error("A bounded backupPath is required");
		}
		const team = await this.configuredTeam();
		return {
			kind: "backup-restore",
			summary: "Run a non-destructive restore drill for a team backup bundle",
			actor: "local-user",
			targets: [{ label: "Backup bundle", value: input.backupPath.trim(), risk: "high" }],
			details: { action: "restore-drill", serverUrl: team.serverUrl, namespace: team.namespace },
		};
	}

	async prepareTeamRestoreDrill(input: TeamRestoreDrillInput): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamRestoreDrillPlan(input));
	}

	async drillTeamRestore(input: TeamRestoreDrillInput, grant: ConfirmationGrant) {
		await this.consent.consume(grant, await this.teamRestoreDrillPlan(input));
		const { client, namespace } = await this.configuredTeam();
		return client.restoreDrill(namespace, input.backupPath.trim());
	}

	protected async teamArtifactProposalPlan(input: TeamArtifactProposalInput) {
		if (!input.artifactJobId?.trim() || input.artifactJobId.length > 200)
			throw new Error("artifactJobId is required");
		if (!input.paperId?.trim() || input.paperId.length > 500) throw new Error("paperId is required");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const paper = await this.personalStore(personalNamespace).getPaper(input.paperId);
		if (!paper) throw new Error("The artifact manifest must be linked to a paper in the selected personal corpus");
		const job = this.jobs.get(input.artifactJobId);
		if (!job || job.status !== "succeeded" || !job.result || typeof job.result !== "object") {
			throw new Error("A completed artifact discovery or acquisition job is required");
		}
		const manifest =
			job.type === "artifact-discovery"
				? (job.result as ArtifactManifest)
				: job.type === "artifact-acquisition"
					? (job.result as { manifest?: ArtifactManifest }).manifest
					: undefined;
		if (!manifest?.pdfSha256 || !Array.isArray(manifest.candidates) || !Array.isArray(manifest.acquisitions)) {
			throw new Error("The selected job does not contain a valid artifact manifest");
		}
		const team = await this.configuredTeam();
		return {
			manifest,
			plan: {
				kind: "team-proposal" as const,
				summary: `Propose the artifact manifest for ${paper.title} to the team knowledge base`,
				actor: "local-user",
				targets: [{ label: "Artifact manifest", value: input.paperId, risk: "high" as const }],
				details: {
					serverUrl: team.serverUrl,
					teamNamespace: team.namespace,
					personalNamespace,
					paper: { id: paper.id, title: paper.title },
					manifest,
				},
			},
		};
	}

	async prepareTeamArtifactProposal(input: TeamArtifactProposalInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamArtifactProposalPlan(input)).plan);
	}

	async proposeTeamArtifact(input: TeamArtifactProposalInput, grant: ConfirmationGrant) {
		const prepared = await this.teamArtifactProposalPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam();
		return client.proposeArtifact(namespace, input.paperId, prepared.manifest);
	}

	protected async teamBlobUploadPlan(input: TeamBlobUploadInput) {
		if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("sha256 is invalid");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const versions = await this.personalStore(personalNamespace).listPaperVersions(input.paperId);
		const version = versions.find((candidate) => candidate.sha256 === input.sha256.toLowerCase());
		if (!version) throw new Error("The selected PDF version is not present in the personal corpus");
		const team = await this.configuredTeam();
		return {
			version,
			plan: {
				kind: "team-proposal" as const,
				summary: "Upload one content-addressed personal PDF version to the team knowledge base",
				actor: "local-user",
				targets: [{ label: "PDF blob", value: `${input.paperId}/${version.sha256}`, risk: "high" as const }],
				details: {
					serverUrl: team.serverUrl,
					teamNamespace: team.namespace,
					personalNamespace,
					paperId: input.paperId,
					sha256: version.sha256,
					bytes: version.bytes,
					contentType: version.contentType,
				},
			},
		};
	}

	async prepareTeamBlobUpload(input: TeamBlobUploadInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamBlobUploadPlan(input)).plan);
	}

	async uploadTeamBlob(input: TeamBlobUploadInput, grant: ConfirmationGrant) {
		const prepared = await this.teamBlobUploadPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const body = await this.readPdfVersionBlob(input.paperId, prepared.version.sha256, input.personalNamespace);
		if (createHash("sha256").update(body).digest("hex") !== prepared.version.sha256) {
			throw new Error("The local PDF blob changed after confirmation");
		}
		const { client, namespace } = await this.configuredTeam();
		const { sha256: _sha256, bytes: _bytes, blobPath: _blobPath, ...version } = prepared.version;
		return client.uploadBlob(namespace, prepared.version.sha256, body, version);
	}

}
