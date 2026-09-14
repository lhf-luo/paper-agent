import type { TeamCorpusClient } from "./team-corpus-client.ts";

/**
 * Categories a proposal asks its records to join.
 *
 * They must already exist: a proposal never defines a shared category, because only a curator decides what a
 * shared category means. The request travels on the review envelope and is applied when a reviewer approves
 * the record, so an unknown id would otherwise be dropped silently at approval time instead of telling the
 * proposer that the category was wrong.
 */
export async function resolveRequestedTopics(
	client: TeamCorpusClient,
	namespace: string,
	topicIds: string[] | undefined,
): Promise<string[] | undefined> {
	const requested = [...new Set((topicIds ?? []).map((id) => id.trim()).filter(Boolean))];
	if (!requested.length) return undefined;
	const known = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 20; page += 1) {
		const result = await client.topics(namespace, cursor, 200);
		for (const topic of result.entries) known.add(topic.id);
		if (!result.nextCursor || result.nextCursor === cursor) break;
		cursor = result.nextCursor;
	}
	const missing = requested.filter((id) => !known.has(id));
	if (missing.length) {
		throw new Error(
			`these categories do not exist on the team service: ${missing.join(", ")}; ask a reviewer to create them first`,
		);
	}
	return requested;
}
