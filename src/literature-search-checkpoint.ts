import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LiteratureProvider, PaperRecord, ProviderFailure } from "./literature-types.ts";

export interface ProviderQueryCheckpoint {
	provider: LiteratureProvider;
	query: string;
	records: PaperRecord[];
	cursor?: string;
	pagesCompleted: number;
	done: boolean;
	failure?: ProviderFailure;
}

interface SearchCheckpointFile {
	schemaVersion: 1;
	configFingerprint: string;
	updatedAt: string;
	outcomes: Record<string, ProviderQueryCheckpoint>;
}

function checkpointKey(provider: LiteratureProvider, query: string): string {
	return `${provider}\u0000${query}`;
}

export class LiteratureSearchCheckpoint {
	private readonly path: string;
	private readonly state: SearchCheckpointFile;
	readonly resumed: boolean;
	private saveChain: Promise<void> = Promise.resolve();

	private constructor(path: string, state: SearchCheckpointFile, resumed: boolean) {
		this.path = path;
		this.state = state;
		this.resumed = resumed;
	}

	static async open(path: string, configFingerprint: string): Promise<LiteratureSearchCheckpoint> {
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as SearchCheckpointFile;
			if (parsed.schemaVersion === 1 && parsed.configFingerprint === configFingerprint && parsed.outcomes) {
				return new LiteratureSearchCheckpoint(path, parsed, true);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
		}
		return new LiteratureSearchCheckpoint(
			path,
			{ schemaVersion: 1, configFingerprint, updatedAt: new Date().toISOString(), outcomes: {} },
			false,
		);
	}

	get(provider: LiteratureProvider, query: string): ProviderQueryCheckpoint | undefined {
		const value = this.state.outcomes[checkpointKey(provider, query)];
		return value ? structuredClone(value) : undefined;
	}

	async update(value: ProviderQueryCheckpoint): Promise<void> {
		this.state.outcomes[checkpointKey(value.provider, value.query)] = structuredClone(value);
		this.state.updatedAt = new Date().toISOString();
		this.saveChain = this.saveChain.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
			await writeFile(temporary, `${JSON.stringify(this.state)}\n`, "utf8");
			await rename(temporary, this.path);
		});
		await this.saveChain;
	}

	async complete(): Promise<void> {
		await this.saveChain;
		try {
			await unlink(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
