import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TeamStateError } from "../domain/team-state-error.ts";
import type { SharedReview, TeamActor } from "../protocol/team-corpus-types.ts";
import { readJson, safeSegment, stableFingerprint, writeJsonAtomic } from "./team-knowledge-serialization.ts";

export interface ReviewedContent {
	review: SharedReview;
}

/** One atomic document holds the published copy, current proposal and review history. */
export interface ReviewedContentEnvelope<T extends ReviewedContent> {
	schemaVersion: 2;
	published?: T;
	latest: T;
	history: T[];
}

export class ReviewedContentRepository<T extends ReviewedContent> {
	readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	private path(key: string): string {
		return join(this.directory, `${safeSegment(key, "knowledge key")}.json`);
	}

	async get(key: string): Promise<ReviewedContentEnvelope<T> | undefined> {
		const value = await readJson<T | ReviewedContentEnvelope<T>>(this.path(key));
		if (!value) return undefined;
		if ("schemaVersion" in value && value.schemaVersion === 2) return value;
		const entry = value as T;
		return {
			schemaVersion: 2,
			latest: entry,
			published: entry.review.status === "team-approved" ? entry : undefined,
			history: [],
		};
	}

	async list(): Promise<Array<{ key: string; state: ReviewedContentEnvelope<T> }>> {
		const result: Array<{ key: string; state: ReviewedContentEnvelope<T> }> = [];
		for (const key of await this.keys()) {
			const state = await this.get(key);
			if (state) result.push({ key, state });
		}
		return result;
	}

	async keys(): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return names
			.sort()
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -5));
	}

	async visible(includePending = false): Promise<T[]> {
		const result: T[] = [];
		for (const key of await this.keys()) {
			const state = await this.get(key);
			if (!state) continue;
			if (state.published) result.push(state.published);
			if (
				includePending &&
				(!state.published || stableFingerprint(state.published) !== stableFingerprint(state.latest))
			)
				result.push(state.latest);
		}
		return result;
	}

	async propose(
		key: string,
		content: Omit<T, "review">,
		actor: TeamActor,
		fingerprint: (entry: Omit<T, "review">) => unknown,
	): Promise<T> {
		const state = await this.get(key);
		const same = (entry: T) => stableFingerprint(fingerprint(entry)) === stableFingerprint(fingerprint(content));
		if (state && !state.latest.review.withdrawnAt && same(state.latest)) return state.latest;
		if (state?.published && same(state.published)) return state.published;
		const entry = {
			...content,
			review: {
				status: "team-proposed",
				proposedBy: actor.name,
				proposedById: actor.id,
				proposedAt: new Date().toISOString(),
				revision: Boolean(state?.published),
			},
		} as T;
		await writeJsonAtomic(this.path(key), {
			schemaVersion: 2,
			published: state?.published,
			latest: entry,
			history: state ? [...state.history, state.latest] : [],
		} satisfies ReviewedContentEnvelope<T>);
		return entry;
	}

	async review(
		key: string,
		decision: "team-approved" | "team-rejected",
		actor: TeamActor,
		reason?: string,
	): Promise<T> {
		const state = await this.get(key);
		if (!state) throw new TeamStateError(404, "Knowledge entry not found");
		if (state.latest.review.withdrawnAt) throw new TeamStateError(409, "The proposal was withdrawn");
		const reviewed = {
			...state.latest,
			review: {
				...state.latest.review,
				status: decision,
				revision: decision === "team-approved" ? false : state.latest.review.revision,
				reviewedBy: actor.name,
				reviewedById: actor.id,
				reviewedAt: new Date().toISOString(),
				reason: reason?.trim() || undefined,
			},
		};
		await writeJsonAtomic(this.path(key), {
			...state,
			latest: reviewed,
			published:
				decision === "team-approved" ? reviewed : state.latest.review.revision ? state.published : undefined,
			history: [...state.history, state.latest],
		});
		return reviewed;
	}

	async withdraw(key: string, actor: TeamActor): Promise<void> {
		const state = await this.get(key);
		if (!state || state.latest.review.status !== "team-proposed")
			throw new TeamStateError(409, "Only pending proposals can be withdrawn");
		await writeJsonAtomic(this.path(key), {
			...state,
			latest: {
				...state.latest,
				review: {
					...state.latest.review,
					status: "team-rejected",
					withdrawnAt: new Date().toISOString(),
					reason: "Proposal withdrawn",
					reviewedBy: actor.name,
					reviewedById: actor.id,
				},
			},
			history: [...state.history, state.latest],
		});
	}
}
