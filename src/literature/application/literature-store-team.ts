import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { paperPrimaryUrl } from "../domain/literature-identifiers.ts";
import type { CorpusManifest, PaperRecord } from "../domain/literature-types.ts";
import { LiteratureStoreMaterials } from "./literature-store-materials.ts";
import { bibKey, csvField, safeSegment, writeJsonAtomic } from "./literature-store-support.ts";

export class LiteratureStoreTeam extends LiteratureStoreMaterials {
	async promoteTo(
		target: LiteratureStoreTeam,
		ids: string[] | undefined,
		contributor: string,
	): Promise<{ promoted: number; missing: string[] }> {
		if (this.scope !== "personal" || target.scope !== "team") {
			throw new Error("Promotion must move records from a personal corpus to a team corpus");
		}
		const records = ids ? await Promise.all(ids.map((id) => this.getPaper(id))) : await this.listPapers();
		const missing = ids?.filter((_id, index) => !records[index]) ?? [];
		const promoted = await target.proposePapers(
			records.filter((record): record is PaperRecord => Boolean(record)),
			contributor,
		);
		return { promoted, missing };
	}

	async proposePapers(records: PaperRecord[], contributor: string): Promise<number> {
		if (this.scope !== "team") throw new Error("Proposals can only be written to a team corpus");
		if (!contributor.trim()) throw new Error("Contributor identity is required");
		await this.initialize();
		let promoted = 0;
		for (const record of records) {
			const existingTarget = await this.getPaper(record.id);
			const reviewed = existingTarget?.curation?.teamReview;
			const proposed: PaperRecord = {
				...record,
				curation: {
					tags: [...(record.curation?.tags ?? [])],
					userNotes: [],
					teamReview:
						reviewed?.status === "team-approved" || reviewed?.status === "team-rejected"
							? reviewed
							: {
									status: "team-proposed",
									proposedBy: contributor.trim(),
									proposedAt: new Date().toISOString(),
								},
				},
			};
			await this.upsertPaper(proposed);
			promoted++;
		}
		return promoted;
	}

	async backupTo(destinationRoot: string): Promise<string> {
		await this.initialize();
		if (this.personalDatabase) return this.personalDatabase.backupTo(destinationRoot);
		const destinationBase = resolve(destinationRoot);
		const relativeDestination = relative(this.root, destinationBase);
		if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !isAbsolute(relativeDestination))) {
			throw new Error("Backup destination must not be inside the corpus root");
		}
		return this.withWriteLock(async () => {
			const timestamp = new Date()
				.toISOString()
				.replace(/[^0-9]/g, "")
				.slice(0, 14);
			const name = `${this.scope}-${this.namespace}-${timestamp}-${randomUUID().slice(0, 8)}`;
			const temporaryPath = join(destinationBase, `${name}.tmp`);
			const finalPath = join(destinationBase, name);
			await mkdir(destinationBase, { recursive: true });
			await cp(this.root, temporaryPath, {
				recursive: true,
				filter: (source) => source !== join(this.root, ".write.lock"),
			});
			await rename(temporaryPath, finalPath);
			return finalPath;
		});
	}

	async export(
		format: "markdown" | "csv" | "bibtex" | "json",
		filename?: string,
		recordsSnapshot?: PaperRecord[],
	): Promise<string> {
		await this.initialize();
		const records = recordsSnapshot ?? (await this.listPapers());
		let content: string;
		let extension: string;
		if (format === "json") {
			extension = "json";
			content = JSON.stringify(
				{
					schemaVersion: 1,
					scope: this.scope,
					namespace: this.namespace,
					exportedAt: new Date().toISOString(),
					records,
				},
				null,
				2,
			);
		} else if (format === "csv") {
			extension = "csv";
			content = [
				["id", "title", "authors", "year", "venue", "doi", "arxiv_id", "url", "sources"].join(","),
				...records.map((record) =>
					[
						record.id,
						record.title,
						record.authors.join("; "),
						record.year,
						record.venue,
						record.identifiers.doi,
						record.identifiers.arxivId,
						paperPrimaryUrl(record),
						record.provenance.map((item) => item.provider).join("; "),
					]
						.map(csvField)
						.join(","),
				),
			].join("\n");
		} else if (format === "bibtex") {
			extension = "bib";
			content = records
				.map((record, index) => {
					const url = paperPrimaryUrl(record);
					const fields = [
						`  title = {${record.title.replace(/[{}]/g, "")}}`,
						`  author = {${record.authors.join(" and ").replace(/[{}]/g, "")}}`,
						record.year ? `  year = {${record.year}}` : undefined,
						record.venue ? `  booktitle = {${record.venue.replace(/[{}]/g, "")}}` : undefined,
						record.identifiers.doi ? `  doi = {${record.identifiers.doi}}` : undefined,
						url ? `  url = {${url}}` : undefined,
					].filter(Boolean);
					return `@misc{${bibKey(record, index)},\n${fields.join(",\n")}\n}`;
				})
				.join("\n\n");
		} else {
			extension = "md";
			content = [
				"# Literature corpus",
				"",
				`Scope: ${this.scope} / ${this.namespace}`,
				"",
				...records.flatMap((record) => [
					`## ${record.title}`,
					"",
					`- Authors: ${record.authors.join(", ") || "unknown"}`,
					`- Year: ${record.year ?? "unknown"}`,
					`- Venue: ${record.venue ?? "unknown"}`,
					`- DOI: ${record.identifiers.doi ?? "none"}`,
					`- URL: ${paperPrimaryUrl(record) ?? "none"}`,
					`- Sources: ${record.provenance.map((item) => item.provider).join(", ")}`,
					"",
				]),
			].join("\n");
		}
		const outputName = filename ? safeSegment(filename, "filename") : `literature-${Date.now()}.${extension}`;
		const outputPath = join(this.root, "exports", outputName);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${content}\n`, "utf8");
		if (this.personalDatabase) {
			try {
				await this.personalDatabase.recordExport(format, outputName, outputPath, records.length);
			} catch (error) {
				await unlink(outputPath).catch(() => {});
				throw error;
			}
		}
		return outputPath;
	}

	async audit(options: { readOnly?: boolean } = {}): Promise<{
		manifest: CorpusManifest;
		recordsMissingPrimaryLink: string[];
		recordsMissingProvenance: string[];
		teamRecordsPendingReview: string[];
	}> {
		const manifest = options.readOnly ? await this.buildManifestSnapshot() : await this.refreshManifest();
		const records = await this.listPapers();
		return {
			manifest,
			recordsMissingPrimaryLink: records.filter((record) => record.links.length === 0).map((record) => record.id),
			recordsMissingProvenance: records
				.filter((record) => record.provenance.length === 0)
				.map((record) => record.id),
			teamRecordsPendingReview: records
				.filter((record) => record.curation?.teamReview?.status === "team-proposed")
				.map((record) => record.id),
		};
	}

	protected async buildManifestSnapshot(): Promise<CorpusManifest> {
		if (this.personalDatabase) return this.personalDatabase.manifest();
		const countJson = async (directory: string) => {
			try {
				return (await readdir(directory)).filter((name) => name.endsWith(".json")).length;
			} catch {
				return 0;
			}
		};
		return {
			schemaVersion: 1,
			scope: this.scope,
			namespace: this.namespace,
			updatedAt: new Date().toISOString(),
			recordCount: await countJson(join(this.root, "records")),
			searchRunCount: await countJson(join(this.root, "search-runs")),
			derivedRecordCount: await countJson(join(this.root, "derived")),
		};
	}

	protected async refreshManifestUnlocked(): Promise<CorpusManifest> {
		const manifest = await this.buildManifestSnapshot();
		await writeJsonAtomic(join(this.root, "manifest.json"), manifest);
		return manifest;
	}

	async refreshManifest(): Promise<CorpusManifest> {
		await this.initialize();
		if (this.personalDatabase) return this.personalDatabase.manifest();
		return this.withWriteLock(() => this.refreshManifestUnlocked());
	}
}
