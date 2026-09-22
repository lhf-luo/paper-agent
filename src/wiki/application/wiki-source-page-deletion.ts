import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { normalizedWikiLabel } from "../domain/wiki-content.ts";
import type {
	WikiEvidence,
	WikiPage,
	WikiSourcePageDeletionEntry,
	WikiSourcePageDeletionPreview,
	WikiSourcePageDeletionResult,
	WikiSyncResult,
} from "../domain/wiki-types.ts";
import { appendWikiLog } from "./wiki-navigation.ts";
import { safeWikiPath } from "./wiki-page-codec.ts";
import { restoreWikiFiles, withWikiWriteLock } from "./wiki-write-lock.ts";

interface WikiSourcePageDeletionDependencies {
	namespace: string;
	directory: string;
	root: string;
	scanPages(): Promise<{ pages: WikiPage[] }>;
	sync(): Promise<WikiSyncResult>;
}

type PreviewDependencies = Pick<WikiSourcePageDeletionDependencies, "namespace" | "scanPages">;

export async function previewWikiSourcePageDeletion(
	dependencies: PreviewDependencies,
	paperIdInput: string,
	includeMixedPageIdsInput: string[] = [],
): Promise<WikiSourcePageDeletionPreview> {
	const paperId = paperIdInput.trim();
	if (!paperId || paperId.length > 512) throw new Error("Wiki source paper id is invalid");
	if (new Set(includeMixedPageIdsInput).size !== includeMixedPageIdsInput.length) {
		throw new Error("include_mixed_page_ids contains duplicate page ids");
	}
	const includeMixedPageIds = includeMixedPageIdsInput.map((id) => id.trim()).sort();
	if (includeMixedPageIds.some((id) => !id || id.length > 128)) {
		throw new Error("include_mixed_page_ids contains an invalid page id");
	}
	const pages = (await dependencies.scanPages()).pages;
	const related = pages.filter((page) => page.evidence.some((item) => evidenceUsesPaper(item, paperId)));
	const entries = related.map((page) => deletionEntry(page, paperId));
	const deletablePages = entries.filter((page) => page.otherSources.length === 0);
	const mixedPages = entries.filter((page) => page.otherSources.length > 0);
	const mixedIds = new Set(mixedPages.map((page) => page.id));
	const invalidOverrides = includeMixedPageIds.filter((id) => !mixedIds.has(id));
	if (invalidOverrides.length) {
		throw new Error(
			`Mixed Wiki page ids do not reference this paper or are not mixed: ${invalidOverrides.join(", ")}`,
		);
	}
	const includedMixed = new Set(includeMixedPageIds);
	const targetPages = [...deletablePages, ...mixedPages.filter((page) => includedMixed.has(page.id))].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	const targetIds = new Set(targetPages.map((page) => page.id));
	const labels = new Map<string, string[]>();
	for (const page of related.filter((candidate) => targetIds.has(candidate.id))) {
		for (const label of [page.title, ...page.aliases]) {
			const normalized = normalizedWikiLabel(label);
			if (normalized) labels.set(normalized, [...(labels.get(normalized) ?? []), page.id]);
		}
	}
	const externalBacklinks = pages
		.filter((page) => !targetIds.has(page.id))
		.map((page) => ({
			pageId: page.id,
			title: page.title,
			targetPageIds: [...new Set(page.links.flatMap((link) => labels.get(normalizedWikiLabel(link)) ?? []))].sort(),
		}))
		.filter((page) => page.targetPageIds.length > 0)
		.sort((a, b) => a.pageId.localeCompare(b.pageId));
	return {
		namespace: dependencies.namespace,
		paperId,
		includeMixedPageIds,
		fingerprint: sourceDeletionFingerprint(
			dependencies.namespace,
			paperId,
			includeMixedPageIds,
			targetPages,
			externalBacklinks,
		),
		generatedAt: new Date().toISOString(),
		deletablePages,
		mixedPages,
		targetPages,
		externalBacklinks,
		blocked: externalBacklinks.length > 0,
	};
}

export async function applyWikiSourcePageDeletion(
	dependencies: WikiSourcePageDeletionDependencies,
	preview: WikiSourcePageDeletionPreview,
): Promise<WikiSourcePageDeletionResult> {
	if (preview.namespace !== dependencies.namespace)
		throw new Error("Wiki deletion preview namespace does not match workspace");
	if (preview.blocked) throw new Error("Wiki deletion has external backlinks; update those pages and preview again");
	return withWikiWriteLock(dependencies.root, async () => {
		const current = await previewWikiSourcePageDeletion(dependencies, preview.paperId, preview.includeMixedPageIds);
		if (current.fingerprint !== preview.fingerprint) {
			throw new Error("Wiki deletion preview changed; run preview again");
		}
		if (current.blocked)
			throw new Error("Wiki deletion has external backlinks; update those pages and preview again");
		if (!current.targetPages.length) {
			return {
				deletedPages: [],
				deletedEvidenceCount: 0,
				previewFingerprint: preview.fingerprint,
				lint: await dependencies.sync(),
			};
		}
		const backups = new Map<string, string | undefined>();
		try {
			for (const page of current.targetPages) {
				const path = safeWikiPath(dependencies.directory, page.relativePath);
				backups.set(path, await readFile(path, "utf8"));
				await rm(path);
			}
			const lint = await dependencies.sync();
			await appendWikiLog(
				dependencies.directory,
				current.targetPages.map((page) => ({
					action: "delete" as const,
					pageId: page.id,
					title: page.title,
					type: page.type,
					status: page.status,
					evidenceIds: page.matchingEvidenceIds,
				})),
			);
			return {
				deletedPages: current.targetPages,
				deletedEvidenceCount: current.targetPages.reduce((sum, page) => sum + page.matchingEvidenceIds.length, 0),
				previewFingerprint: preview.fingerprint,
				lint,
			};
		} catch (error) {
			await restoreWikiFiles(backups);
			await dependencies.sync().catch(() => undefined);
			throw error;
		}
	});
}

function evidenceUsesPaper(evidence: WikiEvidence, paperId: string): boolean {
	return (
		(evidence.kind === "paper" && evidence.sourceId === paperId) ||
		(evidence.kind === "artifact" && evidence.paperId === paperId)
	);
}

function evidenceSourceLabel(evidence: WikiEvidence): string {
	if (evidence.kind === "paper") return `paper:${evidence.sourceId ?? "unknown"}`;
	if (evidence.kind === "note") return `note:${evidence.sourceId ?? "unknown"}`;
	if (evidence.kind === "artifact") return `artifact:${evidence.paperId ?? "unknown"}`;
	return `public:${evidence.locator.url ?? "unknown"}`;
}

function deletionEntry(page: WikiPage, paperId: string): WikiSourcePageDeletionEntry {
	return {
		id: page.id,
		title: page.title,
		type: page.type,
		status: page.status,
		relativePath: page.relativePath,
		contentHash: page.contentHash,
		matchingEvidenceIds: page.evidence.filter((item) => evidenceUsesPaper(item, paperId)).map((item) => item.id),
		otherSources: [
			...new Set(page.evidence.filter((item) => !evidenceUsesPaper(item, paperId)).map(evidenceSourceLabel)),
		],
	};
}

function sourceDeletionFingerprint(
	namespace: string,
	paperId: string,
	includeMixedPageIds: string[],
	targetPages: WikiSourcePageDeletionEntry[],
	externalBacklinks: WikiSourcePageDeletionPreview["externalBacklinks"],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				namespace,
				paperId,
				includeMixedPageIds,
				targetPages: targetPages.map((page) => ({
					id: page.id,
					relativePath: page.relativePath,
					contentHash: page.contentHash,
				})),
				externalBacklinks,
			}),
		)
		.digest("hex");
}
