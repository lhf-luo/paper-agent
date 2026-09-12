import { createHash } from "node:crypto";
import type { LiteratureStore } from "../../literature/application/literature-store.ts";
import { validateResearchNoteMarkdown } from "../../research/domain/research-notes.ts";
import type { TeamContentRef, TeamPageEntry, TeamReviewSnapshot } from "../domain/team-corpus-types.ts";
import type { TeamCorpusClient } from "./team-corpus-client.ts";

export interface TeamKnowledgePullInput {
	entries: TeamContentRef[];
	personalNamespace?: string;
}

export function teamSnapshotMarkdown(
	snapshot: TeamReviewSnapshot,
	source: { serverUrl: string; namespace: string },
): string {
	const origin = {
		serverUrl: source.serverUrl,
		namespace: source.namespace,
		resource: snapshot.resource,
		id: snapshot.id,
		version: snapshot.version,
	};
	const body =
		snapshot.resource === "pages"
			? (snapshot.content as TeamPageEntry).snapshot.markdown
			: `\`\`\`json\n${JSON.stringify(snapshot.content, null, 2)}\n\`\`\``;
	return `# ${snapshot.title.replace(/[\r\n]/g, " ")}\n\n> 团队知识快照 · ${source.namespace}\n\n来源：${source.serverUrl}\n\n内容标识：${snapshot.resource}/${snapshot.id}\n\n版本：${snapshot.version}\n\n<!-- paper-agent-team-source ${JSON.stringify(origin)} -->\n\n---\n\n${body}\n`;
}

export async function previewTeamKnowledgePull(input: {
	client: TeamCorpusClient;
	namespace: string;
	serverUrl: string;
	entries: TeamContentRef[];
	store: LiteratureStore;
}) {
	if (
		!input.entries.length ||
		input.entries.length > 100 ||
		input.entries.some((ref) => !["pages", "derived", "artifacts"].includes(ref.resource))
	)
		throw new Error("Select 1–100 pages, derived records or artifact manifests");
	const refs = input.entries.filter(
		(ref, index) =>
			input.entries.findIndex((other) => ref.id === other.id && ref.resource === other.resource) === index,
	);
	const previews = [];
	for (const ref of refs) {
		const snapshot = await input.client.readContent(input.namespace, ref);
		const id = `team-${createHash("sha256")
			.update(
				JSON.stringify({
					serverUrl: input.serverUrl,
					namespace: input.namespace,
					...ref,
					version: snapshot.version,
				}),
			)
			.digest("hex")
			.slice(0, 40)}`;
		const existing = await input.store.getResearchNote(id);
		const markdown = validateResearchNoteMarkdown(teamSnapshotMarkdown(snapshot, input));
		const linked =
			ref.resource === "pages"
				? (snapshot.content as TeamPageEntry).snapshot.paperIds
				: [
						(snapshot.content as { paperId?: string; record?: { paperId: string } }).paperId ??
							(snapshot.content as { record?: { paperId: string } }).record?.paperId,
					].filter((value): value is string => Boolean(value));
		const paperIds: string[] = [];
		for (const paperId of linked) if (await input.store.getPaper(paperId)) paperIds.push(paperId);
		previews.push({
			snapshot,
			id,
			title: snapshot.title.slice(0, 300),
			markdown,
			paperIds,
			existing: existing
				? {
						revision: existing.revision,
						contentHash: existing.contentHash,
						matches: existing.markdown === markdown,
					}
				: undefined,
		});
	}
	return previews;
}

export async function executeTeamKnowledgePull(
	store: LiteratureStore,
	previews: Awaited<ReturnType<typeof previewTeamKnowledgePull>>,
) {
	const result: { created: string[]; unchanged: string[]; preserved: string[] } = {
		created: [],
		unchanged: [],
		preserved: [],
	};
	for (const preview of previews) {
		// A stable note id includes the approved version; later imports never overwrite a person's edits.
		const existing = await store.getResearchNote(preview.id);
		if (existing) {
			result[existing.markdown === preview.markdown ? "unchanged" : "preserved"].push(preview.id);
			continue;
		}
		await store.createResearchNote({
			id: preview.id,
			title: preview.title,
			markdown: preview.markdown,
			paperIds: preview.paperIds,
		});
		result.created.push(preview.id);
	}
	return result;
}
