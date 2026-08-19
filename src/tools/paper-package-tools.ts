import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LiteratureStore, resolveCorpusRoot } from "../literature-store.ts";
import type {
	ArtifactManifest,
	PaperMaterialPackage,
	PaperPackageTableRow,
	PaperRecord,
	PaperVersion,
	ProvenanceProvider,
} from "../literature-types.ts";

function primaryIdentifier(record: PaperRecord): string {
	if (record.identifiers.doi) return `doi:${record.identifiers.doi}`;
	if (record.identifiers.arxivId) return `arXiv:${record.identifiers.arxivId}`;
	if (record.identifiers.openAlexId) return `OpenAlex:${record.identifiers.openAlexId}`;
	if (record.identifiers.semanticScholarId) return `S2:${record.identifiers.semanticScholarId}`;
	return record.id;
}

function metadataLabel(record: PaperRecord): string {
	return [
		record.title,
		record.authors.length ? record.authors.slice(0, 4).join(", ") : "authors unavailable",
		record.year ?? "year unknown",
		record.venue ?? "venue unknown",
		primaryIdentifier(record),
	]
		.map(String)
		.join("; ");
}

function versionLabel(versions: PaperVersion[]): string {
	if (!versions.length) return "no PDF version saved";
	return versions
		.map((version) =>
			[
				version.versionKind ?? "unknown",
				version.versionLabel ?? version.contentType,
				`sha256=${version.sha256}`,
				`bytes=${version.bytes}`,
				version.isPreferred ? "preferred" : undefined,
			]
				.filter(Boolean)
				.join(" "),
		)
		.join(" | ");
}

function pdfLabel(record: PaperRecord, versions: PaperVersion[]): string {
	const saved = versions.map((version) => version.blobPath).join(" | ");
	const links = record.links.filter((link) => link.kind === "pdf").map((link) => link.url);
	return [saved, ...links].filter(Boolean).join(" | ") || "missing";
}

function artifactLabel(record: PaperRecord, manifests: ArtifactManifest[]): string {
	const links = record.links.filter((link) => link.kind === "artifact").map((link) => link.url);
	const acquired = manifests.flatMap((manifest) =>
		manifest.acquisitions.map((snapshot) =>
			[
				snapshot.candidateId,
				snapshot.status,
				snapshot.localPath ?? snapshot.finalUrl ?? snapshot.sourceUrl,
				snapshot.commit ? `commit=${snapshot.commit}` : undefined,
				snapshot.sha256 ? `sha256=${snapshot.sha256}` : undefined,
			]
				.filter(Boolean)
				.join(" "),
		),
	);
	const discovered = manifests.flatMap((manifest) =>
		manifest.candidates.map((candidate) => `${candidate.id}:${candidate.kind}:${candidate.url}`),
	);
	return [...acquired, ...links, ...discovered].filter(Boolean).join(" | ") || "missing";
}

function discoverySourceLabel(record: PaperRecord): string {
	const providers = new Set<ProvenanceProvider>(record.provenance.map((item) => item.provider));
	const paths = (record.discoveryPaths ?? []).map((path) =>
		[path.kind, path.provider, path.query, path.seedPaperId].filter(Boolean).join(":"),
	);
	return [[...providers].join(", "), paths.join(" | ")].filter(Boolean).join("; ") || "unknown";
}

function latestTimestamp(record: PaperRecord, versions: PaperVersion[], manifests: ArtifactManifest[]): string {
	const candidates = [
		...record.provenance.map((item) => item.retrievedAt),
		record.curation?.screening?.updatedAt,
		record.curation?.reading?.updatedAt,
		...versions.map((version) => version.retrievedAt),
		...manifests.map((manifest) => manifest.discoveredAt),
		...manifests.flatMap((manifest) => manifest.acquisitions.map((snapshot) => snapshot.retrievedAt)),
	].filter((value): value is string => Boolean(value));
	return candidates.sort().at(-1) ?? "unknown";
}

export function buildPaperPackageTableRow(
	record: PaperRecord,
	versions: PaperVersion[],
	artifactManifests: ArtifactManifest[] = [],
): PaperPackageTableRow {
	const screening = record.curation?.screening;
	const reading = record.curation?.reading;
	return {
		paperId: record.id,
		metadata: metadataLabel(record),
		version: versionLabel(versions),
		pdf: pdfLabel(record, versions),
		artifact: artifactLabel(record, artifactManifests),
		discoverySource: discoverySourceLabel(record),
		screeningStatus: screening ? `${screening.status}${screening.reason ? `: ${screening.reason}` : ""}` : "unreviewed",
		readingStatus: reading ? `${reading.status}${reading.note ? `: ${reading.note}` : ""}` : "unread",
		updatedAt: latestTimestamp(record, versions, artifactManifests),
	};
}

export function buildPaperMaterialPackage(
	record: PaperRecord,
	versions: PaperVersion[],
	artifactManifests: ArtifactManifest[] = [],
): PaperMaterialPackage {
	const missing: string[] = [];
	if (!versions.length && !record.links.some((link) => link.kind === "pdf")) missing.push("pdf");
	if (!artifactManifests.length && !record.links.some((link) => link.kind === "artifact")) {
		missing.push("artifact");
	}
	return {
		paperId: record.id,
		record,
		versions,
		artifactManifests,
		tableRow: buildPaperPackageTableRow(record, versions, artifactManifests),
		missing,
	};
}

async function readArtifactManifests(paths: string[] | undefined, cwd: string): Promise<ArtifactManifest[]> {
	const manifests: ArtifactManifest[] = [];
	for (const path of paths ?? []) {
		const absolute = resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
		const parsed = JSON.parse(await readFile(absolute, "utf8")) as ArtifactManifest;
		if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.candidates) || !Array.isArray(parsed.acquisitions)) {
			throw new Error(`Invalid artifact manifest: ${absolute}`);
		}
		manifests.push(parsed);
	}
	return manifests;
}

function tableCell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function formatPackage(row: PaperPackageTableRow): string {
	const header = "paper_id | 元数据 | 版本 | PDF | artifact | 发现来源 | 筛选状态 | 阅读状态 | 更新时间";
	const separator = "--- | --- | --- | --- | --- | --- | --- | --- | ---";
	return [
		"Paper material package:",
		header,
		separator,
		[
			row.paperId,
			row.metadata,
			row.version,
			row.pdf,
			row.artifact,
			row.discoverySource,
			row.screeningStatus,
			row.readingStatus,
			row.updatedAt,
		]
			.map(tableCell)
			.join(" | "),
	].join("\n");
}

export function registerPaperPackageTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "build_paper_package",
		label: "Build paper package",
		description:
			"Build a traceable material package row for a persistent corpus paper by joining metadata, saved PDF versions, optional artifact manifests, discovery provenance, screening status, reading status, and update time.",
		promptSnippet: "Build a traceable paper material package from corpus metadata, PDF versions, and artifacts",
		promptGuidelines: [
			"Use after saving literature records and downloading PDFs or acquiring artifacts.",
			"Pass artifact_manifest_paths when artifacts were acquired from a local PDF; this tool summarizes manifests but does not download or clone content.",
			"Report missing PDF or artifact materials explicitly instead of inventing availability.",
		],
		parameters: Type.Object({
			paper_id: Type.String(),
			namespace: Type.Optional(Type.String()),
			corpus_root: Type.Optional(Type.String()),
			artifact_manifest_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const namespace = params.namespace ?? "default";
			const store = new LiteratureStore(resolveCorpusRoot(ctx.cwd, "personal", namespace, params.corpus_root), "personal", namespace);
			const record = await store.getPaper(params.paper_id);
			if (!record) throw new Error(`Paper not found in personal corpus: ${params.paper_id}`);
			const versions = await store.listPaperVersions(record.id);
			const manifests = await readArtifactManifests(params.artifact_manifest_paths, ctx.cwd);
			const materialPackage = buildPaperMaterialPackage(record, versions, manifests);
			return {
				content: [
					{
						type: "text",
						text: [
							formatPackage(materialPackage.tableRow),
							"",
							`Missing materials: ${materialPackage.missing.join(", ") || "none"}`,
							`Corpus: ${store.root}`,
						].join("\n"),
					},
				],
				details: { ...materialPackage, corpusPath: store.root },
			};
		},
	});
}
