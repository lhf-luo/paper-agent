import type { ZoteroCollectionMapping, ZoteroItemMapping } from "../../extensions/zotero/domain/zotero-types.ts";
import { LiteratureStoreTeam } from "./literature-store-team.ts";

export type {
	LocalPaperImportInput,
	LocalPaperImportOptions,
	LocalPaperImportResult,
} from "./literature-store-support.ts";
export { resolveCorpusRoot } from "./literature-store-support.ts";

export class LiteratureStore extends LiteratureStoreTeam {
	private requirePersonalDatabase() {
		if (!this.personalDatabase) throw new Error("Zotero integration is available only for personal corpora");
		return this.personalDatabase;
	}

	async listZoteroItemMappings(serverId: string): Promise<ZoteroItemMapping[]> {
		await this.initialize();
		return this.requirePersonalDatabase().listZoteroItemMappings(serverId);
	}

	async listZoteroCollectionMappings(serverId: string): Promise<ZoteroCollectionMapping[]> {
		await this.initialize();
		return this.requirePersonalDatabase().listZoteroCollectionMappings(serverId);
	}

	async saveZoteroItemMapping(mapping: ZoteroItemMapping): Promise<void> {
		await this.initialize();
		return this.requirePersonalDatabase().saveZoteroItemMapping(mapping);
	}

	async saveZoteroCollectionMapping(mapping: ZoteroCollectionMapping): Promise<void> {
		await this.initialize();
		return this.requirePersonalDatabase().saveZoteroCollectionMapping(mapping);
	}
}

export function derivedCacheKey(input: {
	inputHashes: string[];
	operation: string;
	pipelineVersion: string;
	modelVersion?: string;
	promptVersion?: string;
	normalizedConfig: unknown;
}): string {
	const stable = JSON.stringify({
		inputHashes: [...input.inputHashes].sort(),
		operation: input.operation,
		pipelineVersion: input.pipelineVersion,
		modelVersion: input.modelVersion ?? null,
		promptVersion: input.promptVersion ?? null,
		normalizedConfig: input.normalizedConfig,
	});
	return createHash("sha256").update(stable).digest("hex");
}

import { createHash } from "node:crypto";
