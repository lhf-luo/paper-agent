import { normalizeArxivId, normalizeDoi, normalizeTitle } from "../domain/literature-identifiers.ts";
import type {
	ArtifactManifest,
	ArtifactSnapshot,
	DerivedRecord,
	PaperCollection,
	PaperPublicationVersion,
	PaperRecord,
	PaperVersion,
} from "../domain/literature-types.ts";
import type { LiteratureStore } from "./literature-store.ts";

export interface PersonalPaperCollectionPath {
	id: string;
	name: string;
	path: string[];
}

export interface PersonalPaperArtifactDetails {
	links: PaperRecord["links"];
	candidates: ArtifactManifest["candidates"];
	latestAcquisitions: ArtifactSnapshot[];
	discoveryWarnings: NonNullable<ArtifactManifest["discoveryWarnings"]>;
}

export interface PersonalPaperDetails {
	namespace: string;
	record: PaperRecord;
	collections: PersonalPaperCollectionPath[];
	remotePdfLinks: PaperRecord["links"];
	publicationVersions: PaperPublicationVersion[];
	localPdfVersions: PaperVersion[];
	artifacts: PersonalPaperArtifactDetails;
	derivedRecords: DerivedRecord[];
}

export type PersonalPaperLookupResult =
	| { status: "found"; paper: PersonalPaperDetails }
	| { status: "not-found"; candidates: PaperRecord[] }
	| { status: "ambiguous"; candidates: PaperRecord[] };

function collectionPath(collection: PaperCollection, byId: Map<string, PaperCollection>): string[] {
	const path: string[] = [];
	const visited = new Set<string>();
	let current: PaperCollection | undefined = collection;
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		path.unshift(current.name);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
}

function latestArtifactAcquisitions(manifests: ArtifactManifest[]): ArtifactSnapshot[] {
	const latest = new Map<string, ArtifactSnapshot>();
	for (const snapshot of manifests.flatMap((manifest) => manifest.acquisitions)) {
		const previous = latest.get(snapshot.candidateId);
		if (!previous || snapshot.retrievedAt >= previous.retrievedAt) latest.set(snapshot.candidateId, snapshot);
	}
	return [...latest.values()].sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt));
}

function uniqueArtifactCandidates(manifests: ArtifactManifest[]): ArtifactManifest["candidates"] {
	const candidates = new Map<string, ArtifactManifest["candidates"][number]>();
	for (const candidate of manifests.flatMap((manifest) => manifest.candidates))
		candidates.set(candidate.id, candidate);
	return [...candidates.values()];
}

function exactMatches(records: PaperRecord[], query: string): PaperRecord[] {
	const normalizedQuery = normalizeTitle(query);
	const doi = normalizeDoi(query);
	const arxivId = normalizeArxivId(query);
	return records.filter(
		(record) =>
			record.id.toLowerCase() === query.trim().toLowerCase() ||
			(doi !== undefined && normalizeDoi(record.identifiers.doi) === doi) ||
			(arxivId !== undefined && normalizeArxivId(record.identifiers.arxivId) === arxivId) ||
			normalizeTitle(record.title) === normalizedQuery,
	);
}

async function lookupCandidates(store: LiteratureStore, query: string): Promise<PersonalPaperLookupResult> {
	const records = await store.listPapers();
	const exact = exactMatches(records, query);
	if (exact.length === 1) return { status: "found", paper: await buildPersonalPaperDetails(store, exact[0]) };
	if (exact.length > 1) return { status: "ambiguous", candidates: exact };
	const candidates = (await store.searchPapers({ query, limit: 10, readOnly: true })).map((hit) => hit.record);
	return { status: "not-found", candidates };
}

export async function buildPersonalPaperDetails(
	store: LiteratureStore,
	record: PaperRecord,
): Promise<PersonalPaperDetails> {
	const [collections, publicationVersions, versions, manifests, derivedRecords] = await Promise.all([
		store.listCollections(),
		store.listPublicationVersions(record.id),
		store.listPaperVersions(record.id),
		store.listArtifactManifests(record.id),
		store.listDerived({ paperId: record.id }),
	]);
	const byCollectionId = new Map(collections.map((collection) => [collection.id, collection]));
	const paperCollections = (record.collectionIds ?? [])
		.map((id) => byCollectionId.get(id))
		.filter((collection): collection is PaperCollection => Boolean(collection))
		.map((collection) => ({
			id: collection.id,
			name: collection.name,
			path: collectionPath(collection, byCollectionId),
		}))
		.sort((left, right) => left.path.join("/").localeCompare(right.path.join("/")));
	return {
		namespace: store.namespace,
		record,
		collections: paperCollections,
		remotePdfLinks: record.links.filter((link) => link.kind === "pdf"),
		publicationVersions,
		localPdfVersions: versions,
		artifacts: {
			links: record.links.filter((link) => link.kind === "artifact"),
			candidates: uniqueArtifactCandidates(manifests),
			latestAcquisitions: latestArtifactAcquisitions(manifests),
			discoveryWarnings: manifests.flatMap((manifest) => manifest.discoveryWarnings ?? []),
		},
		derivedRecords,
	};
}

export async function queryPersonalLibraryPaper(
	store: LiteratureStore,
	query: string,
): Promise<PersonalPaperLookupResult> {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("query is required");
	return lookupCandidates(store, trimmed);
}
