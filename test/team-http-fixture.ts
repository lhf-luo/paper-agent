import type { TeamReviewSnapshot } from "../src/team/domain/team-corpus-types.ts";

/** Existing scenario fixtures explicitly preview their seeded content before reviewing it.
 * Integrity tests use native fetch directly to verify missing/stale versions are rejected. */
export const fetchWithReviewPreview: typeof fetch = async (input, init) => {
	const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
	const match = /^(\/v1\/namespaces\/[^/]+)\/(reviews|derived\/reviews|artifacts\/reviews|pages\/reviews)$/.exec(
		url.pathname,
	);
	if (match && init?.method === "POST" && typeof init.body === "string") {
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(init.body) as Record<string, unknown>;
		} catch {
			return fetch(input, init);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) return fetch(input, init);
		const ids = body.paperIds ?? body.keys;
		if (
			body.expectedVersions === undefined &&
			Array.isArray(ids) &&
			ids.length &&
			["team-approved", "team-rejected"].includes(String(body.decision))
		) {
			const preview = await fetch(new URL(`${match[1]}/reviews/preview`, url), {
				...init,
				body: JSON.stringify({ resource: match[2] === "reviews" ? "papers" : match[2].split("/")[0], ids }),
			});
			if (preview.ok) {
				const snapshot = (await preview.json()) as { entries: TeamReviewSnapshot[] };
				init = {
					...init,
					body: JSON.stringify({
						...body,
						expectedVersions: Object.fromEntries(snapshot.entries.map((entry) => [entry.id, entry.version])),
					}),
				};
			} else await preview.arrayBuffer();
		}
	}
	return fetch(input, init);
};
