import type { ArtifactManifest, DerivedRecord, PaperRecord } from "../../literature/domain/literature-types.ts";
import type {
	ConfirmationGrant,
	OperationPlan,
	PreparedOperation,
} from "../../shared/application/operation-consent.ts";
import {
	sanitizeArtifactManifestForTeamProposal,
	sanitizePaperRecordForTeamProposal,
	TeamCorpusHttpError,
} from "../../team/application/team-corpus-client.ts";
import { executeTeamPull, previewTeamPull, type TeamPullPreview } from "../../team/application/team-pull.ts";
import type { TeamPageSnapshot, TeamReviewVersions } from "../../team/domain/team-corpus-types.ts";
import type { WikiWorkspace } from "../../wiki/application/wiki-workspace.ts";
import { absolutePathLocations, createWikiWorkspaceForStore } from "../../team/application/team-personal-sources.ts";

import type {
	TeamArtifactProposalInput,
	TeamBlobUploadInput,
	TeamDerivedProposalInput,
	TeamPagesProposalInput,
	TeamPaperProposalInput,
	TeamPullInput,
	TeamPullResult,
	TeamRestoreDrillInput,
	TeamReviewInput,
	TeamWithdrawInput,
} from "./paper-agent-contracts.ts";
import { PaperAgentTeamAccess } from "./paper-agent-team-access.ts";

export { absolutePathLocations, createWikiWorkspaceForStore };

export abstract class PaperAgentTeamOperations extends PaperAgentTeamAccess {
	/**
	 * Read-only wiki workspace wiring used by the pages proposal flow. `PaperAgentWiki` exposes the same
	 * construction as its public `wikiWorkspace()`; keeping the wiring here lets team operations read personal
	 * wiki pages without depending on a subclass.
	 */
	protected wikiWorkspaceFor(namespace = this.defaultNamespace): WikiWorkspace {
		return createWikiWorkspaceForStore(this.dataRoot, namespace, this.personalStore(namespace));
	}

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
					connectionFingerprint: team.connectionFingerprint,
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
		const { client, namespace } = await this.configuredTeam(prepared.plan.details.connectionFingerprint as string);
		return client.proposePapers(namespace, prepared.records);
	}

	/**
	 * Resolve every requested team paper plus its preferred PDF version so the confirmation manifest can
	 * disclose exactly what will be written into the personal library.
	 */
	protected async teamPullPlan(input: TeamPullInput): Promise<{
		plan: OperationPlan;
		previews: TeamPullPreview[];
		personalNamespace: string;
		includePdf: boolean;
	}> {
		if (!input.paperIds.length || input.paperIds.length > 200)
			throw new Error("Select between 1 and 200 team papers");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const includePdf = input.includePdf ?? false;
		const { client, namespace, serverUrl, connectionFingerprint } = await this.configuredTeam();
		const previews = await previewTeamPull(client, namespace, input.paperIds);
		return {
			previews,
			personalNamespace,
			includePdf,
			plan: {
				kind: "personal-corpus-write",
				summary: `Pull ${previews.length} team paper record(s) into the personal library${includePdf ? " with PDFs" : ""}`,
				actor: "local-user",
				targets: previews.map((preview) => ({
					label: preview.record.title.slice(0, 120),
					value: preview.record.id,
					risk: "medium" as const,
				})),
				details: {
					serverUrl,
					connectionFingerprint,
					teamNamespace: namespace,
					personalNamespace,
					includePdf,
					papers: previews.map((preview) => ({
						id: preview.record.id,
						title: preview.record.title,
						hasPdf: Boolean(preview.version),
						pdfSha256: preview.version?.sha256,
					})),
				},
			},
		};
	}

	async prepareTeamPull(input: TeamPullInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamPullPlan(input)).plan);
	}

	async pullTeamPapers(input: TeamPullInput, grant: ConfirmationGrant): Promise<TeamPullResult> {
		const prepared = await this.teamPullPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam(prepared.plan.details.connectionFingerprint as string);
		const store = this.personalStore(prepared.personalNamespace);
		await store.initialize();
		// The previews were fetched by the plan that was just consumed, so what lands is exactly what the manifest
		// disclosed; no second round of team requests is needed.
		return executeTeamPull({
			client,
			namespace,
			store,
			previews: prepared.previews,
			includePdf: prepared.includePdf,
		});
	}

	protected async teamDerivedProposalPlan(input: TeamDerivedProposalInput): Promise<{
		records: DerivedRecord[];
		plan: OperationPlan;
	}> {
		if (!input.keys.length || input.keys.length > 200)
			throw new Error("Select between 1 and 200 personal derived records");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const store = this.personalStore(personalNamespace);
		await store.initialize();
		const records: DerivedRecord[] = [];
		const warnings: string[] = [];
		for (const key of input.keys) {
			const record = await store.getDerived(key);
			if (!record) throw new Error(`Personal corpus does not contain derived record: ${key}`);
			if (!(await store.getPaper(record.paperId))) {
				throw new Error(
					`Derived record ${key} references paper ${record.paperId}, which is not in the personal corpus`,
				);
			}
			records.push(record);
			for (const location of absolutePathLocations(record.result)) {
				warnings.push(`${key}: absolute path retained at ${location}`);
			}
		}
		const team = await this.configuredTeam();
		return {
			records,
			plan: {
				kind: "team-proposal",
				summary: `Propose ${records.length} personal derived record(s) to the team knowledge base`,
				actor: "local-user",
				targets: records.map((record) => ({
					label: `${record.operation} · ${record.key}`.slice(0, 120),
					value: record.key,
					risk: "medium" as const,
				})),
				details: {
					serverUrl: team.serverUrl,
					connectionFingerprint: team.connectionFingerprint,
					teamNamespace: team.namespace,
					personalNamespace,
					keys: records.map((record) => record.key),
					warnings,
					preview: records,
				},
			},
		};
	}

	async prepareTeamDerivedProposal(input: TeamDerivedProposalInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamDerivedProposalPlan(input)).plan);
	}

	async proposeTeamDerived(input: TeamDerivedProposalInput, grant: ConfirmationGrant) {
		const prepared = await this.teamDerivedProposalPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam(prepared.plan.details.connectionFingerprint as string);
		return client.proposeDerived(namespace, prepared.records);
	}

	protected async teamPagesProposalPlan(input: TeamPagesProposalInput): Promise<{
		records: TeamPageSnapshot[];
		plan: OperationPlan;
	}> {
		if (!input.sources.length || input.sources.length > 200)
			throw new Error("Select between 1 and 200 personal knowledge sources");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const store = this.personalStore(personalNamespace);
		await store.initialize();
		const workspace = this.wikiWorkspaceFor(personalNamespace);
		const records: TeamPageSnapshot[] = [];
		const warnings: string[] = [];
		const seen = new Set<string>();
		for (const source of input.sources) {
			const key = `${source.kind}.${source.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			let snapshot: TeamPageSnapshot;
			if (source.kind === "note") {
				const note = await store.getResearchNote(source.id);
				if (!note) throw new Error(`Personal knowledge base does not contain research note: ${source.id}`);
				snapshot = {
					key,
					sourceId: note.id,
					sourceNamespace: personalNamespace,
					kind: "note",
					title: note.title,
					markdown: note.markdown,
					contentHash: note.contentHash,
					revision: note.revision,
					paperIds: note.papers.map((paper) => paper.id),
					createdAt: new Date().toISOString(),
				};
			} else {
				const detail = await workspace.get(source.id);
				if (!detail) throw new Error(`Personal wiki does not contain page: ${source.id}`);
				const page = detail.page;
				snapshot = {
					key,
					sourceId: page.id,
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
					createdAt: new Date().toISOString(),
				};
			}
			records.push(snapshot);
			for (const location of absolutePathLocations(snapshot.markdown.split("\n"))) {
				warnings.push(`${key}: absolute path retained at ${location}`);
			}
		}
		const team = await this.configuredTeam();
		return {
			records,
			plan: {
				kind: "team-proposal",
				summary: `Propose ${records.length} personal knowledge page(s) to the team knowledge base`,
				actor: "local-user",
				targets: records.map((record) => ({
					label: `${record.kind} · ${record.title}`.slice(0, 120),
					value: record.key,
					risk: "medium" as const,
				})),
				details: {
					serverUrl: team.serverUrl,
					connectionFingerprint: team.connectionFingerprint,
					teamNamespace: team.namespace,
					personalNamespace,
					keys: records.map((record) => record.key),
					warnings,
					preview: records.map(({ createdAt: _createdAt, ...snapshot }) => snapshot),
				},
			},
		};
	}

	async prepareTeamPagesProposal(input: TeamPagesProposalInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamPagesProposalPlan(input)).plan);
	}

	async proposeTeamPages(input: TeamPagesProposalInput, grant: ConfirmationGrant) {
		const prepared = await this.teamPagesProposalPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam(prepared.plan.details.connectionFingerprint as string);
		return client.proposePages(namespace, prepared.records);
	}

	protected async teamWithdrawPlan(input: TeamWithdrawInput): Promise<OperationPlan> {
		if (!input.paperIds.length || input.paperIds.length > 200)
			throw new Error("Select between 1 and 200 pending proposals to withdraw");
		const team = await this.configuredTeam();
		const preview = await Promise.all(
			input.paperIds.map((id) =>
				team.client.readContent(team.namespace, { resource: "papers", id }, { pending: true }),
			),
		);
		return {
			kind: "team-write",
			summary: `Withdraw ${input.paperIds.length} pending team proposal(s)`,
			actor: "local-user",
			targets: input.paperIds.map((id) => ({ label: "Pending proposal", value: id, risk: "high" as const })),
			details: {
				serverUrl: team.serverUrl,
				teamNamespace: team.namespace,
				paperIds: [...input.paperIds],
				connectionFingerprint: team.connectionFingerprint,
				preview,
				expectedVersions: Object.fromEntries(preview.map((entry) => [entry.id, entry.version])),
			},
		};
	}

	async prepareTeamWithdraw(input: TeamWithdrawInput): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamWithdrawPlan(input));
	}

	async withdrawTeamProposals(input: TeamWithdrawInput, grant: ConfirmationGrant) {
		const plan = await this.teamWithdrawPlan(input);
		await this.consent.consume(grant, plan);
		const { client, namespace } = await this.configuredTeam(plan.details.connectionFingerprint as string);
		return client.withdrawPapers(namespace, input.paperIds, plan.details.expectedVersions as TeamReviewVersions);
	}

	protected async teamReviewPlan(
		input: TeamReviewInput,
	): Promise<{ plan: OperationPlan; versions: TeamReviewVersions }> {
		if (!input.ids.length || input.ids.length > 500) throw new Error("Select between 1 and 500 team entries");
		if (input.reason && input.reason.length > 10_000) throw new Error("Review reason is too long");
		const team = await this.configuredTeam();
		const { entries } = await team.client.previewReview(team.namespace, input.resource, input.ids);
		const versions = Object.fromEntries(entries.map((entry) => [entry.id, entry.version]));
		if (input.expectedVersions && entries.some((entry) => input.expectedVersions?.[entry.id] !== entry.version))
			throw new TeamCorpusHttpError(409, "Displayed team content changed; reopen it before reviewing");
		return {
			versions,
			plan: {
				kind: "team-review",
				summary: `${input.decision === "team-approved" ? "Approve" : "Reject"} ${input.ids.length} team ${input.resource} entr${input.ids.length === 1 ? "y" : "ies"}`,
				actor: "local-user",
				targets: input.ids.map((id) => ({ label: input.resource, value: id, risk: "high" as const })),
				details: {
					serverUrl: team.serverUrl,
					namespace: team.namespace,
					connectionFingerprint: team.connectionFingerprint,
					...input,
					preview: entries,
					expectedVersions: versions,
				},
			},
		};
	}

	async prepareTeamReview(input: TeamReviewInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.teamReviewPlan(input)).plan);
	}

	async reviewTeamEntries(input: TeamReviewInput, grant: ConfirmationGrant) {
		const prepared = await this.teamReviewPlan(input);
		await this.consent.consume(grant, prepared.plan);
		const { client, namespace } = await this.configuredTeam(prepared.plan.details.connectionFingerprint as string);
		if (input.resource === "papers")
			return client.reviewPapers(namespace, input.ids, input.decision, input.reason, prepared.versions);
		if (input.resource === "derived")
			return client.reviewDerived(namespace, input.ids, input.decision, input.reason, prepared.versions);
		if (input.resource === "pages")
			return client.reviewPages(namespace, input.ids, input.decision, input.reason, prepared.versions);
		return client.reviewArtifacts(namespace, input.ids, input.decision, input.reason, prepared.versions);
	}

	protected async teamBackupPlan(): Promise<OperationPlan> {
		const team = await this.configuredTeam();
		return {
			kind: "backup-restore",
			summary: "Create a server-side backup of the team knowledge namespace",
			actor: "local-user",
			targets: [{ label: "Team namespace", value: `${team.serverUrl}/${team.namespace}`, risk: "medium" }],
			details: {
				action: "backup",
				serverUrl: team.serverUrl,
				namespace: team.namespace,
				connectionFingerprint: team.connectionFingerprint,
			},
		};
	}

	async prepareTeamBackup(): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamBackupPlan());
	}

	async backupTeam(grant: ConfirmationGrant) {
		const plan = await this.teamBackupPlan();
		await this.consent.consume(grant, plan);
		const { client, namespace } = await this.configuredTeam(plan.details.connectionFingerprint as string);
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
			details: {
				action: "restore-drill",
				serverUrl: team.serverUrl,
				namespace: team.namespace,
				connectionFingerprint: team.connectionFingerprint,
			},
		};
	}

	async prepareTeamRestoreDrill(input: TeamRestoreDrillInput): Promise<PreparedOperation> {
		return this.consent.prepare(await this.teamRestoreDrillPlan(input));
	}

	async drillTeamRestore(input: TeamRestoreDrillInput, grant: ConfirmationGrant) {
		const plan = await this.teamRestoreDrillPlan(input);
		await this.consent.consume(grant, plan);
		const { client, namespace } = await this.configuredTeam(plan.details.connectionFingerprint as string);
		return client.restoreDrill(namespace, input.backupPath.trim());
	}

	protected async teamArtifactProposalPlan(input: TeamArtifactProposalInput) {
		if (!input.artifactJobId?.trim() && !input.manifestSha256)
			throw new Error("Select a completed artifact job or a saved manifest");
		if (input.artifactJobId && input.artifactJobId.length > 200) throw new Error("artifactJobId is too long");
		if (!input.paperId?.trim() || input.paperId.length > 500) throw new Error("paperId is required");
		const personalNamespace = input.personalNamespace ?? this.defaultNamespace;
		const paper = await this.personalStore(personalNamespace).getPaper(input.paperId);
		if (!paper) throw new Error("The artifact manifest must be linked to a paper in the selected personal corpus");
		const job = input.artifactJobId ? this.jobs.get(input.artifactJobId) : undefined;
		if (
			input.artifactJobId &&
			(!job || job.status !== "succeeded" || !job.result || typeof job.result !== "object")
		) {
			throw new Error("A completed artifact discovery or acquisition job is required");
		}
		const source = job
			? job.type === "artifact-discovery"
				? (job.result as ArtifactManifest)
				: job.type === "artifact-acquisition"
					? (job.result as { manifest?: ArtifactManifest }).manifest
					: undefined
			: (await this.personalStore(personalNamespace).listArtifactManifests(input.paperId)).find(
					(entry) => entry.pdfSha256 === input.manifestSha256,
				);
		if (!source?.pdfSha256 || !Array.isArray(source.candidates) || !Array.isArray(source.acquisitions)) {
			throw new Error("The selected job does not contain a valid artifact manifest");
		}
		const manifest = sanitizeArtifactManifestForTeamProposal(source);
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
					connectionFingerprint: team.connectionFingerprint,
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
		const { client, namespace } = await this.configuredTeam(prepared.plan.details.connectionFingerprint as string);
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
					connectionFingerprint: team.connectionFingerprint,
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
		const { client, namespace } = await this.configuredTeam(prepared.plan.details.connectionFingerprint as string);
		const { sha256: _sha256, bytes: _bytes, blobPath: _blobPath, ...version } = prepared.version;
		return client.uploadBlobFile(namespace, prepared.version.sha256, prepared.version.blobPath, version);
	}
}
