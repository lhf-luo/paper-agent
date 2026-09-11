import { createHash } from "node:crypto";
import { mergePaperRecords } from "../../literature/domain/literature-identifiers.ts";
import type { PaperRecord, PaperVersion } from "../../literature/domain/literature-types.ts";
import type { TeamCorpusClient } from "./team-corpus-client.ts";

/**
 * Shared "team → personal" pull logic used by the application layer (Web / local HTTP API) and the Pi tool.
 * Keeping it in one place means the sanitisation rules and the SHA-256 check cannot drift between the two
 * entry points.
 */

export interface TeamPullResult {
	pulled: number;
	created: string[];
	updated: string[];
	unchanged: string[];
	pdfs: Array<{ paperId: string; sha256: string; status: "stored" | "existed" | "failed"; reason?: string }>;
}

export interface TeamPullPreview {
	record: PaperRecord;
	/** Preferred PDF version on the team side, when one exists. */
	version?: PaperVersion;
}

/** The personal-store surface a pull needs; `LiteratureStore` satisfies it. */
export interface TeamPullTarget {
	upsertPaper(record: PaperRecord): Promise<"created" | "updated" | "unchanged">;
	putBlob(data: Uint8Array): Promise<{ sha256: string; path: string; existed: boolean }>;
	savePaperVersion(version: PaperVersion): Promise<void>;
}

/** Resolve every requested team paper and its preferred PDF version so a confirmation manifest can list them. */
export async function previewTeamPull(
	client: TeamCorpusClient,
	namespace: string,
	paperIds: string[],
): Promise<TeamPullPreview[]> {
	return Promise.all(
		paperIds.map(async (id) => {
			const record = await client.getPaper(namespace, id);
			const { versions } = await client.listPaperVersions(namespace, id);
			return { record, version: versions.find((version) => version.isPreferred) ?? versions[0] };
		}),
	);
}

/**
 * Personal notes and screening opinions never travel back down; the team review marker stays so the personal
 * copy is recognisable as team-sourced. The result is canonicalised into the shape the personal store derives
 * on its first merge, so pulling the same paper twice reports `unchanged` instead of churning an update.
 */
export function sanitizePulledRecord(record: PaperRecord): PaperRecord {
	const pulled: PaperRecord = {
		...record,
		curation: {
			tags: [...(record.curation?.tags ?? [])],
			userNotes: [],
			screening: undefined,
			reading: record.curation?.reading,
			teamReview: record.curation?.teamReview,
		},
	};
	const canonical = mergePaperRecords(pulled, pulled);
	canonical.id = pulled.id;
	return canonical;
}

export async function executeTeamPull(input: {
	client: TeamCorpusClient;
	namespace: string;
	store: TeamPullTarget;
	previews: TeamPullPreview[];
	includePdf: boolean;
}): Promise<TeamPullResult> {
	const result: TeamPullResult = { pulled: 0, created: [], updated: [], unchanged: [], pdfs: [] };
	for (const preview of input.previews) {
		const record = sanitizePulledRecord(preview.record);
		const status = await input.store.upsertPaper(record);
		result.pulled += 1;
		result[status].push(record.id);
		if (!input.includePdf) continue;
		try {
			const version = preview.version;
			if (!version) throw new Error("No PDF version is available for this team paper");
			const blob = await input.client.downloadBlob(input.namespace, version.sha256);
			if (createHash("sha256").update(blob.body).digest("hex") !== version.sha256) {
				throw new Error("Downloaded PDF SHA-256 does not match the version metadata");
			}
			const stored = await input.store.putBlob(blob.body);
			await input.store.savePaperVersion({
				...version,
				paperId: record.id,
				sha256: stored.sha256,
				bytes: blob.body.byteLength,
				blobPath: stored.path,
				contentType: version.contentType || blob.contentType,
			});
			result.pdfs.push({ paperId: record.id, sha256: stored.sha256, status: stored.existed ? "existed" : "stored" });
		} catch (error) {
			result.pdfs.push({
				paperId: record.id,
				sha256: preview.version?.sha256 ?? "",
				status: "failed",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}
