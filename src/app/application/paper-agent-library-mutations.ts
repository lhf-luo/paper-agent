import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	corpusAnnotationPlan,
	corpusExportFilename,
	corpusExportPlan,
	corpusTitleRepairPlan,
} from "../../literature/application/corpus-operations.ts";
import {
	metadataRefreshDiff,
	refreshPersonalPaperMetadata,
} from "../../literature/application/literature-metadata-refresh.ts";
import { runAuthorizedMutation } from "../../literature/application/literature-write.ts";
import { normalizeArxivId, normalizeDoi, sha256Text } from "../../literature/domain/literature-identifiers.ts";
import type { PaperCollection, PaperRecord } from "../../literature/domain/literature-types.ts";
import type {
	ConfirmationGrant,
	OperationPlan,
	PreparedOperation,
} from "../../shared/application/operation-consent.ts";

import type {
	PersonalCorpusAnnotationInput,
	PersonalCorpusExportInput,
	PersonalMetadataEnrichmentInput,
	PersonalPaperRemovalInput,
	PersonalPdfVersionRemovalInput,
	PersonalTitleRepairInput,
} from "./paper-agent-contracts.ts";
import { PaperAgentLibrary } from "./paper-agent-library.ts";

function isWithinDirectory(root: string, candidate: string): boolean {
	const path = relative(resolve(root), resolve(candidate));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function artifactAvailability(store: ReturnType<PaperAgentLibrary["personalStore"]>, paperId: string) {
	const artifactRoot = join(store.personalFilesRoot, paperId, "artifacts");
	const latest = new Map<
		string,
		Awaited<ReturnType<typeof store.listArtifactManifests>>[number]["acquisitions"][number]
	>();
	for (const snapshot of (await store.listArtifactManifests(paperId)).flatMap((manifest) => manifest.acquisitions)) {
		const previous = latest.get(snapshot.candidateId);
		if (!previous || snapshot.retrievedAt >= previous.retrievedAt) latest.set(snapshot.candidateId, snapshot);
	}
	let count = 0;
	for (const snapshot of latest.values()) {
		if (!snapshot.localPath || !["cloned", "downloaded", "skipped"].includes(snapshot.status)) continue;
		if (!isWithinDirectory(artifactRoot, snapshot.localPath)) continue;
		try {
			const local = await stat(snapshot.localPath);
			if (local.isDirectory() || local.isFile()) count += 1;
		} catch {
			// Stale manifest paths are not available artifacts.
		}
	}
	return { artifactRoot, count, available: count > 0 };
}

interface PreparedPaperRemovalSnapshot {
	namespace: string;
	mode: PersonalPaperRemovalInput["mode"];
	collectionId?: string;
	paperIds: string[];
	paperFingerprints: Record<string, string>;
	wikiFingerprint?: string;
	store: ReturnType<PaperAgentLibrary["personalStore"]>;
	plan: OperationPlan;
	expiresAt: string;
}

function sameStringSet(left: string[], right: string[]): boolean {
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

export abstract class PaperAgentLibraryMutations extends PaperAgentLibrary {
	private readonly preparedPaperRemovals = new Map<string, PreparedPaperRemovalSnapshot>();
	private readonly preparedMetadataEnrichments = new Map<
		string,
		{
			namespace: string;
			paperId: string;
			originalFingerprint: string;
			record: PaperRecord;
			filledFields: string[];
			replacedFields: string[];
			matchedProviders: string[];
			warnings: Array<{ provider: string; message: string; code?: "identity-conflict" }>;
			plan: OperationPlan;
			expiresAt: string;
		}
	>();

	private async metadataIdentityConflict(
		store: ReturnType<PaperAgentLibrary["personalStore"]>,
		paperId: string,
		record: PaperRecord,
	): Promise<string | undefined> {
		const doi = normalizeDoi(record.identifiers.doi);
		const arxivId = normalizeArxivId(record.identifiers.arxivId);
		if (!doi && !arxivId) return undefined;
		return (await store.listPapers()).find((candidate) => {
			if (candidate.id === paperId) return false;
			return (
				(Boolean(doi) && normalizeDoi(candidate.identifiers.doi) === doi) ||
				(Boolean(arxivId) && normalizeArxivId(candidate.identifiers.arxivId) === arxivId)
			);
		})?.id;
	}

	async preparePersonalMetadataEnrichment(input: PersonalMetadataEnrichmentInput) {
		const paperId = input.paperId.trim();
		if (!paperId || paperId.length > 500) throw new Error("Personal paper id is invalid");
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const original = await store.getPaper(paperId);
		if (!original) throw new Error(`Personal corpus does not contain: ${paperId}`);
		const refreshed = await refreshPersonalPaperMetadata(original, this.projectRoot, {
			searcher: this.metadataProviderSearcher,
			doiLookup: this.doiProviderLookup,
		});
		const diff = metadataRefreshDiff(original, refreshed.record);
		const response = {
			paperId,
			filledFields: diff.filledFields,
			replacedFields: diff.replacedFields,
			matchedProviders: refreshed.matchedProviders,
			warnings: refreshed.warnings,
		};
		const conflictingPaperId = await this.metadataIdentityConflict(store, paperId, refreshed.record);
		if (conflictingPaperId) {
			return { ...response, status: "identity-conflict" as const, conflictingPaperId, prepared: null };
		}
		if (refreshed.identityConflict && !refreshed.hadMatch) {
			return { ...response, status: "identity-conflict" as const, prepared: null };
		}
		if (!diff.changed) {
			return {
				...response,
				status: refreshed.hadMatch ? ("unchanged" as const) : ("no-match" as const),
				prepared: null,
			};
		}
		const labels = [
			diff.filledFields.length ? `add ${diff.filledFields.join(", ")}` : undefined,
			diff.replacedFields.length ? `replace ${diff.replacedFields.join(", ")}` : undefined,
		].filter(Boolean);
		const originalFingerprint = sha256Text(JSON.stringify(original));
		const plan: OperationPlan = {
			kind: "personal-corpus-write",
			summary: `Refresh metadata for ${original.title}: ${labels.join("; ")}`,
			actor: input.author?.trim() || "local-user",
			targets: [{ label: "personal-paper", value: `${namespace}/${paperId}`, risk: "low" }],
			details: {
				namespace,
				paperId,
				originalFingerprint,
				refreshedFingerprint: sha256Text(JSON.stringify(refreshed.record)),
				filledFields: diff.filledFields,
				replacedFields: diff.replacedFields,
				matchedProviders: refreshed.matchedProviders,
				warnings: refreshed.warnings,
			},
		};
		const prepared = await this.consent.prepare(plan);
		this.preparedMetadataEnrichments.set(prepared.operationId, {
			namespace,
			paperId,
			originalFingerprint,
			record: refreshed.record,
			filledFields: diff.filledFields,
			replacedFields: diff.replacedFields,
			matchedProviders: refreshed.matchedProviders,
			warnings: refreshed.warnings,
			plan,
			expiresAt: prepared.expiresAt,
		});
		return { ...response, status: "ready" as const, prepared };
	}

	async enrichPersonalPaperMetadata(input: PersonalMetadataEnrichmentInput, grant: ConfirmationGrant) {
		const now = Date.now();
		for (const [id, item] of this.preparedMetadataEnrichments) {
			if (Date.parse(item.expiresAt) <= now) this.preparedMetadataEnrichments.delete(id);
		}
		const prepared = this.preparedMetadataEnrichments.get(grant.operationId);
		if (!prepared) throw new Error("Prepared metadata enrichment was not found or has expired; prepare again");
		const namespace = input.namespace ?? this.defaultNamespace;
		if (prepared.namespace !== namespace || prepared.paperId !== input.paperId.trim()) {
			throw new Error("Prepared metadata enrichment does not match the requested paper");
		}
		const store = this.personalStore(namespace);
		const current = await store.getPaper(prepared.paperId);
		if (!current) throw new Error(`Personal corpus does not contain: ${prepared.paperId}`);
		if (sha256Text(JSON.stringify(current)) !== prepared.originalFingerprint) {
			throw new Error("Paper metadata changed after preparation; prepare the enrichment again");
		}
		const conflictingPaperId = await this.metadataIdentityConflict(store, prepared.paperId, prepared.record);
		if (conflictingPaperId) {
			throw new Error(`Refreshed identifiers already belong to personal paper: ${conflictingPaperId}`);
		}
		try {
			const status = await runAuthorizedMutation({ manager: this.consent, grant }, prepared.plan, () =>
				store.replacePaperMetadata(prepared.record),
			);
			const paper = await store.getPaper(prepared.paperId);
			if (!paper) throw new Error("Refreshed personal paper could not be reloaded");
			return {
				status,
				paper,
				filledFields: prepared.filledFields,
				replacedFields: prepared.replacedFields,
				matchedProviders: prepared.matchedProviders,
				warnings: prepared.warnings,
			};
		} finally {
			this.preparedMetadataEnrichments.delete(grant.operationId);
		}
	}

	protected async personalPaperRemovalOperation(input: PersonalPaperRemovalInput) {
		const requestedIds = input.paperIds;
		if (requestedIds.length < 1 || requestedIds.length > 1_000) {
			throw new Error("Select between 1 and 1000 personal papers");
		}
		const paperIds = requestedIds.map((id) => id.trim());
		if (paperIds.some((id) => !id || id.length > 500)) throw new Error("Personal paper ids are invalid");
		if (new Set(paperIds).size !== paperIds.length) throw new Error("Personal paper ids contain duplicates");
		const collectionId = input.collectionId?.trim() || undefined;
		if (input.mode === "remove-from-collection" && !collectionId) {
			throw new Error("collectionId is required when removing papers from a collection");
		}
		if (input.mode === "permanent-delete" && collectionId) {
			throw new Error("collectionId is not accepted for permanent deletion");
		}
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const loaded = await store.getPapers(paperIds);
		const recordsById = new Map(loaded.map((paper) => [paper.id, paper]));
		const missing = paperIds.filter((id) => !recordsById.has(id));
		if (missing.length) throw new Error(`Personal corpus does not contain: ${missing.join(", ")}`);
		const papers = paperIds.map((id) => recordsById.get(id)).filter((paper): paper is PaperRecord => Boolean(paper));
		let collection: PaperCollection | undefined;
		if (input.mode === "remove-from-collection") {
			collection = (await store.listCollections()).find((value) => value.id === collectionId);
			if (!collection) throw new Error(`Collection not found: ${collectionId}`);
			const outsideCollection = papers.filter((paper) => !paper.collectionIds?.includes(collectionId!));
			if (outsideCollection.length) {
				throw new Error(
					`Papers are not assigned to collection ${collection.name}: ${outsideCollection.map((paper) => paper.id).join(", ")}`,
				);
			}
		}
		const permanentTargets = input.mode === "permanent-delete" ? papers : [];
		const cleanup = await store.paperDeletionImpact(permanentTargets.map((paper) => paper.id));
		const wikiPreview = permanentTargets.length
			? await this.wikiWorkspace(namespace).previewPaperDependencies(paperIds)
			: undefined;
		const wikiDependencies = (wikiPreview?.dependencies ?? [])
			.map((dependency) => ({
				paperId: dependency.paperId,
				paperTitle: recordsById.get(dependency.paperId)?.title ?? dependency.paperId,
				pageCount: dependency.pages.length,
				evidenceCount: dependency.pages.reduce((sum, page) => sum + page.evidenceCount, 0),
				pages: dependency.pages.map((page) => ({ id: page.id, title: page.title, mixed: page.mixed })),
			}))
			.filter((item) => item.pageCount > 0);
		const wikiPageCount = wikiDependencies.reduce((sum, item) => sum + item.pageCount, 0);
		const author = input.author?.trim() || "local-user";
		return {
			namespace,
			store,
			papers,
			paperIds,
			paperFingerprints: Object.fromEntries(papers.map((paper) => [paper.id, sha256Text(JSON.stringify(paper))])),
			wikiFingerprint: wikiPreview?.fingerprint,
			collection,
			collectionId,
			mode: input.mode,
			plan: {
				kind: "personal-paper-remove" as const,
				summary:
					input.mode === "remove-from-collection"
						? `从分类“${collection!.name}”移除 ${papers.length} 篇论文`
						: `永久删除 ${papers.length} 篇论文及相关本地数据${wikiPageCount ? `；${wikiPageCount} 个 Wiki 页面将失去来源` : ""}`,
				actor: author,
				targets: [
					...papers.map((paper) => ({
						label: input.mode === "remove-from-collection" ? "分类关系" : "个人库论文",
						value:
							input.mode === "remove-from-collection"
								? `${collection!.name}/${paper.title}`
								: `${namespace}/${paper.title}`,
						risk: input.mode === "remove-from-collection" ? ("medium" as const) : ("high" as const),
					})),
					...wikiDependencies.flatMap((dependency) =>
						dependency.pages.map((page) => ({
							label: "关联 Wiki（不会删除）",
							value: `${namespace}/${page.title}`,
							risk: "high" as const,
						})),
					),
				],
				details: {
					namespace,
					mode: input.mode,
					paperId: papers.length === 1 ? papers[0].id : undefined,
					paperIds,
					paperCount: papers.length,
					collectionId,
					...cleanup,
					noteAssociations: "Paper deletion removes note links but keeps Markdown notes.",
					wikiDependencies,
					wikiWarning: wikiPageCount
						? "Deleting these papers does not delete Wiki pages. Use delete_research_wiki_source_pages afterward to remove pages backed by an intentionally deleted source."
						: undefined,
				},
			},
		};
	}

	async preparePersonalPaperRemoval(input: PersonalPaperRemovalInput): Promise<PreparedOperation> {
		const snapshot = await this.personalPaperRemovalOperation(input);
		const prepared = await this.consent.prepare(snapshot.plan);
		this.preparedPaperRemovals.set(prepared.operationId, {
			...snapshot,
			expiresAt: prepared.expiresAt,
		});
		return prepared;
	}

	async removePersonalPaper(input: PersonalPaperRemovalInput, grant: ConfirmationGrant) {
		const now = Date.now();
		for (const [id, item] of this.preparedPaperRemovals) {
			if (Date.parse(item.expiresAt) <= now) this.preparedPaperRemovals.delete(id);
		}
		const snapshot = this.preparedPaperRemovals.get(grant.operationId);
		if (!snapshot) throw new Error("Prepared paper removal was not found or has expired; prepare again");
		const namespace = input.namespace ?? this.defaultNamespace;
		if (snapshot.namespace !== namespace) throw new Error("Prepared paper removal namespace changed; prepare again");
		if (snapshot.mode !== input.mode) throw new Error("Prepared paper removal mode changed; prepare again");
		if (snapshot.collectionId !== (input.collectionId?.trim() || undefined)) {
			throw new Error("Prepared paper removal collection changed; prepare again");
		}
		if (
			!sameStringSet(
				snapshot.paperIds,
				input.paperIds.map((id) => id.trim()),
			)
		) {
			throw new Error("Prepared paper removal selection changed; prepare again");
		}
		try {
			const current = await snapshot.store.getPapers(snapshot.paperIds);
			if (
				current.length !== snapshot.paperIds.length ||
				current.some((paper) => sha256Text(JSON.stringify(paper)) !== snapshot.paperFingerprints[paper.id])
			) {
				throw new Error("Personal papers changed after preparation; prepare the removal again");
			}
			if (snapshot.wikiFingerprint) {
				const wiki = await this.wikiWorkspace(snapshot.namespace).previewPaperDependencies(snapshot.paperIds);
				if (wiki.fingerprint !== snapshot.wikiFingerprint) {
					throw new Error("Wiki dependencies changed after preparation; prepare the removal again");
				}
			}
			return await runAuthorizedMutation({ manager: this.consent, grant }, snapshot.plan, async () => {
				if (snapshot.mode === "remove-from-collection") {
					const updated = await snapshot.store.updatePaperCollectionMembership(
						snapshot.paperIds,
						snapshot.collectionId!,
						"unassign",
					);
					return {
						namespace: snapshot.namespace,
						mode: snapshot.mode,
						paper: updated.length === 1 ? updated[0] : undefined,
						removedFromCollection: updated.map((paper) => paper.id),
						deleted: [],
						missing: [],
						blobWarnings: [],
					};
				}
				const result = await snapshot.store.deletePapers(snapshot.paperIds);
				return {
					namespace: snapshot.namespace,
					mode: snapshot.mode,
					removedFromCollection: [],
					...result,
				};
			});
		} finally {
			this.preparedPaperRemovals.delete(grant.operationId);
		}
	}

	protected async personalPdfVersionRemovalOperation(input: PersonalPdfVersionRemovalInput) {
		const paperId = input.paperId.trim();
		const sha256 = input.sha256.trim().toLowerCase();
		if (!paperId || paperId.length > 500) throw new Error("Personal paper id is invalid");
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("PDF version SHA-256 is invalid");
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const paper = await store.getPaper(paperId);
		if (!paper) throw new Error(`Personal corpus does not contain: ${paperId}`);
		const version = (await store.listPaperVersions(paperId)).find(
			(candidate) => candidate.sha256.toLowerCase() === sha256,
		);
		if (!version) throw new Error("PDF version was not found in the selected corpus");
		const material = await store.getPdfMaterial(paperId);
		const deletesMineruMaterial = material?.sourceSha256.toLowerCase() === sha256;
		const plan: OperationPlan = {
			kind: "personal-paper-remove",
			summary: `Delete ${version.versionKind ?? "unknown"} PDF version from ${paper.title}`,
			actor: input.author?.trim() || "local-user",
			targets: [{ label: "PDF version", value: `${namespace}/${paperId}/${sha256}`, risk: "high" }],
			details: {
				namespace,
				paperId,
				title: paper.title,
				sha256,
				bytes: version.bytes,
				versionKind: version.versionKind ?? "unknown",
				versionLabel: version.versionLabel,
				isPreferred: Boolean(version.isPreferred),
				deletesMineruMaterial,
			},
		};
		return { namespace, store, paper, version, plan };
	}

	async preparePersonalPdfVersionRemoval(input: PersonalPdfVersionRemovalInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.personalPdfVersionRemovalOperation(input)).plan);
	}

	async removePersonalPdfVersion(input: PersonalPdfVersionRemovalInput, grant: ConfirmationGrant) {
		const prepared = await this.personalPdfVersionRemovalOperation(input);
		return runAuthorizedMutation({ manager: this.consent, grant }, prepared.plan, async () => ({
			namespace: prepared.namespace,
			paperId: prepared.paper.id,
			...(await prepared.store.deletePaperVersion(prepared.paper.id, prepared.version.sha256)),
		}));
	}

	async paperDetails(id: string, namespace = this.defaultNamespace) {
		const store = this.personalStore(namespace);
		const paper = await store.getPaper(id);
		if (!paper) return undefined;
		const [versions, derived, artifact] = await Promise.all([
			store.listPaperVersions(id),
			store.listDerived({ paperId: id }),
			artifactAvailability(store, id),
		]);
		return {
			paper,
			versions,
			derived,
			artifact: { available: artifact.available, count: artifact.count },
		};
	}

	async openPaperArtifactFolder(id: string, namespace = this.defaultNamespace) {
		const store = this.personalStore(namespace);
		if (!(await store.getPaper(id))) throw new Error(`Personal corpus does not contain: ${id}`);
		const artifact = await artifactAvailability(store, id);
		if (!artifact.available) throw new Error("该论文没有可用的本地 Artifact");
		const command =
			process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
		const opened = await this.executor.exec(command, [artifact.artifactRoot], { detached: true });
		if (opened.code !== 0 || opened.killed) {
			throw new Error(opened.stderr.trim() || "无法打开 Artifact 文件夹");
		}
		return { opened: true, artifactCount: artifact.count };
	}

	async openPaperPdfFolder(id: string, sha256: string, namespace = this.defaultNamespace) {
		const store = this.personalStore(namespace);
		if (!(await store.getPaper(id))) throw new Error(`Personal corpus does not contain: ${id}`);
		const version = (await store.listPaperVersions(id)).find(
			(candidate) => candidate.sha256.toLowerCase() === sha256.toLowerCase(),
		);
		if (!version) throw new Error("PDF version was not found in the selected corpus");
		const path = resolve(version.blobPath);
		if (!isWithinDirectory(store.personalFilesRoot, path)) {
			throw new Error("PDF file resolves outside the selected namespace");
		}
		const file = await stat(path).catch(() => undefined);
		if (!file?.isFile()) throw new Error("PDF file is missing from local storage");
		const command =
			process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
		const opened = await this.executor.exec(command, [dirname(path)], { detached: true });
		if (opened.code !== 0 || opened.killed) {
			throw new Error(opened.stderr.trim() || "无法打开当前 PDF 文件夹");
		}
		return { opened: true };
	}

	protected async personalAnnotationOperation(input: PersonalCorpusAnnotationInput) {
		if (!Array.isArray(input.paperIds) || input.paperIds.length < 1 || input.paperIds.length > 500) {
			throw new Error("Select between 1 and 500 personal papers");
		}
		const paperIds = [...new Set(input.paperIds.map((id) => id.trim()))];
		if (paperIds.some((id) => !id || id.length > 500)) throw new Error("Personal paper ids are invalid");
		const author = input.author?.trim() || "local-user";
		if (author.length > 200) throw new Error("Annotation author is too long");
		const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
		if (tags.length > 50 || tags.some((tag) => tag.length > 100)) {
			throw new Error("Annotations may contain at most 50 tags of 100 characters or fewer");
		}
		const note = input.note?.trim() || undefined;
		if (note && note.length > 20_000) throw new Error("Annotation note is too long");
		const screeningReason = input.screeningReason?.trim() || undefined;
		if (screeningReason && screeningReason.length > 10_000) throw new Error("Screening reason is too long");
		if (
			input.screeningStatus !== undefined &&
			!["unreviewed", "include", "exclude", "maybe"].includes(input.screeningStatus)
		) {
			throw new Error("Screening status is invalid");
		}
		if (!tags.length && !note && !input.screeningStatus) {
			throw new Error("Add at least one tag, note, or screening status");
		}
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const requested = await Promise.all(paperIds.map(async (id) => ({ id, record: await store.getPaper(id) })));
		const missing = requested.filter((item) => !item.record).map((item) => item.id);
		if (missing.length) throw new Error(`Personal corpus does not contain: ${missing.join(", ")}`);
		const records = requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record));
		const annotation = {
			author,
			tags: tags.length ? tags : undefined,
			note,
			screeningStatus: input.screeningStatus,
			screeningReason,
		};
		return { namespace, store, records, annotation, plan: corpusAnnotationPlan(store, records, annotation) };
	}

	async preparePersonalAnnotation(input: PersonalCorpusAnnotationInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.personalAnnotationOperation(input)).plan);
	}

	/** 收集待清洗的标题；没有脏标题时返回 undefined，无需用户确认。 */
	protected async personalTitleRepairOperation(input: PersonalTitleRepairInput) {
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		const scope = input.paperIds?.length ? new Set(input.paperIds.map((id) => id.trim())) : undefined;
		const candidates = (await store.listPapers()).filter((record) => !scope || scope.has(record.id));
		const plan = corpusTitleRepairPlan(store, candidates, input.author?.trim() || "local-user");
		return plan ? { namespace, store, plan } : undefined;
	}

	async preparePersonalTitleRepair(input: PersonalTitleRepairInput): Promise<PreparedOperation | undefined> {
		const operation = await this.personalTitleRepairOperation(input);
		return operation ? this.consent.prepare(operation.plan) : undefined;
	}

	async repairPersonalPaperTitles(input: PersonalTitleRepairInput, grant: ConfirmationGrant) {
		const operation = await this.personalTitleRepairOperation(input);
		if (!operation) return { namespace: input.namespace ?? this.defaultNamespace, repaired: 0, repairs: [] };
		const repairs = await runAuthorizedMutation({ manager: this.consent, grant }, operation.plan, () =>
			operation.store.repairPaperMetadata(input.paperIds),
		);
		return { namespace: operation.namespace, repaired: repairs.length, repairs };
	}

	async annotatePersonalPapers(input: PersonalCorpusAnnotationInput, grant: ConfirmationGrant) {
		const prepared = await this.personalAnnotationOperation(input);
		const updated = await runAuthorizedMutation({ manager: this.consent, grant }, prepared.plan, async () => {
			const values: PaperRecord[] = [];
			for (const record of prepared.records) {
				values.push(await prepared.store.annotatePaper(record.id, prepared.annotation));
			}
			return values;
		});
		return { namespace: prepared.namespace, updated, count: updated.length };
	}

	protected async personalExportOperation(input: PersonalCorpusExportInput) {
		if (!["markdown", "csv", "bibtex", "json"].includes(input.format)) {
			throw new Error("Export format must be markdown, csv, bibtex, or json");
		}
		const namespace = input.namespace ?? this.defaultNamespace;
		const store = this.personalStore(namespace);
		let records: PaperRecord[];
		if (input.paperIds?.length) {
			if (input.paperIds.length > 1_000) throw new Error("Select at most 1000 papers for one export");
			const paperIds = [...new Set(input.paperIds.map((id) => id.trim()))];
			const requested = await Promise.all(paperIds.map(async (id) => ({ id, record: await store.getPaper(id) })));
			const missing = requested.filter((item) => !item.record).map((item) => item.id);
			if (missing.length) throw new Error(`Personal corpus does not contain: ${missing.join(", ")}`);
			records = requested.map((item) => item.record).filter((record): record is PaperRecord => Boolean(record));
		} else {
			records = await store.listPapers();
		}
		if (!records.length) throw new Error("The selected personal corpus export is empty");
		const filename = corpusExportFilename(input.format, input.filename, "literature-export");
		return { namespace, store, records, filename, plan: corpusExportPlan(store, input.format, filename, records) };
	}

	async preparePersonalExport(input: PersonalCorpusExportInput): Promise<PreparedOperation> {
		return this.consent.prepare((await this.personalExportOperation(input)).plan);
	}

	async exportPersonalCorpus(input: PersonalCorpusExportInput, grant: ConfirmationGrant) {
		const prepared = await this.personalExportOperation(input);
		const path = await runAuthorizedMutation({ manager: this.consent, grant }, prepared.plan, () =>
			prepared.store.export(input.format, prepared.filename, prepared.records),
		);
		return {
			namespace: prepared.namespace,
			format: input.format,
			filename: prepared.filename,
			path,
			count: prepared.records.length,
		};
	}

	async readPersonalExport(filename: string, namespace = this.defaultNamespace): Promise<Buffer> {
		const safeFilename = corpusExportFilename(
			filename.toLowerCase().endsWith(".bib")
				? "bibtex"
				: filename.toLowerCase().endsWith(".csv")
					? "csv"
					: filename.toLowerCase().endsWith(".json")
						? "json"
						: "markdown",
			filename,
			"literature-export",
		);
		const store = this.personalStore(namespace);
		const root = resolve(store.root, "exports");
		const path = resolve(root, safeFilename);
		const relativePath = relative(root, path);
		if (relativePath.startsWith("..") || isAbsolute(relativePath))
			throw new Error("Export path is outside the corpus");
		return readFile(path);
	}
}
