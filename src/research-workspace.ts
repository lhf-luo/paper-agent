import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DerivedRecord } from "./literature-types.ts";

export type ResearchRecordKind = "skim-card" | "comparison-matrix" | "evidence-graph";
export type ResearchAuthorType = "human" | "ai-assisted";

export interface ResearchAuthorship {
	type: ResearchAuthorType;
	author: string;
	model?: string;
	humanReviewed: boolean;
	reviewedBy?: string;
	reviewedAt?: string;
}

export interface SourceLocator {
	paperId: string;
	versionSha256?: string;
	page?: number;
	quote?: string;
	quoteSha256?: string;
	assetId?: string;
}

interface ResearchRecordBase {
	id: string;
	title: string;
	authorship: ResearchAuthorship;
	createdAt: string;
	updatedAt: string;
	revision: number;
}

export interface SkimCard extends ResearchRecordBase {
	kind: "skim-card";
	paperId: string;
	researchQuestion: string;
	problem: string;
	method: string;
	datasets: string;
	findings: string;
	limitations: string;
	unknowns: string;
	sources: SourceLocator[];
}

export interface ComparisonCell {
	value: string;
	sources: SourceLocator[];
	confidence?: "high" | "medium" | "low";
}

export interface ComparisonMatrix extends ResearchRecordBase {
	kind: "comparison-matrix";
	dimensions: string[];
	paperIds: string[];
	cells: Record<string, Record<string, ComparisonCell>>;
}

export interface EvidenceCard {
	id: string;
	claim: string;
	stance: "support" | "challenge" | "unknown";
	evidence: string;
	confidence: "high" | "medium" | "low";
	sources: SourceLocator[];
}

export interface EvidenceEdge {
	from: string;
	to: string;
	relation: "supports" | "challenges" | "depends-on" | "contradicts";
}

export interface EvidenceGraph extends ResearchRecordBase {
	kind: "evidence-graph";
	question: string;
	humanConclusion: string;
	aiSuggestions?: string;
	cards: EvidenceCard[];
	edges: EvidenceEdge[];
}

export type ResearchRecord = SkimCard | ComparisonMatrix | EvidenceGraph;

export interface ResearchAuditEvent {
	id: string;
	at: string;
	action: "create" | "update";
	recordKind: ResearchRecordKind;
	recordId: string;
	author: string;
	authorType: ResearchAuthorType;
	humanReviewed: boolean;
	reviewedBy?: string;
	revision: number;
}

function safeSegment(value: string, label: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
	return value;
}

function paperIdentifier(value: unknown): string {
	if (typeof value !== "string") throw new Error("Paper identifiers must be strings");
	const normalized = value.trim();
	if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new Error("Paper identifiers must be non-empty bounded text without control characters");
	}
	return normalized;
}

function normalizedHash(value: unknown): string {
	const normalize = (entry: unknown): unknown =>
		Array.isArray(entry)
			? entry.map(normalize)
			: entry && typeof entry === "object"
				? Object.fromEntries(
						Object.entries(entry as Record<string, unknown>)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, child]) => [key, normalize(child)]),
					)
				: entry;
	return createHash("sha256")
		.update(JSON.stringify(normalize(value)))
		.digest("hex");
}

function validateSource(source: SourceLocator): SourceLocator {
	if (!source || typeof source !== "object") throw new Error("Every source locator requires a paperId");
	const paperId = paperIdentifier(source.paperId);
	if (source.versionSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(source.versionSha256))
		throw new Error("Source versionSha256 must be a SHA-256 value");
	if (source.page !== undefined && (!Number.isInteger(source.page) || source.page < 1 || source.page > 100_000))
		throw new Error("Source page must be a positive physical page number");
	if (source.quote !== undefined && (typeof source.quote !== "string" || source.quote.length > 20_000))
		throw new Error("Source quote is too long");
	const quoteSha256 = source.quote ? createHash("sha256").update(source.quote).digest("hex") : source.quoteSha256;
	if (quoteSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(quoteSha256))
		throw new Error("Source quoteSha256 must be a SHA-256 value");
	return { ...source, paperId, quoteSha256 };
}

function validateAuthorship(value: ResearchAuthorship, fallbackReviewedAt?: string): ResearchAuthorship {
	if (!value || !["human", "ai-assisted"].includes(value.type) || !value.author?.trim() || value.author.length > 200)
		throw new Error("Research authorship is invalid");
	const author = value.author.trim();
	if (!value.humanReviewed) {
		return {
			...value,
			author,
			model: value.model?.trim() || undefined,
			humanReviewed: false,
			reviewedBy: undefined,
			reviewedAt: undefined,
		};
	}
	const reviewedBy = (value.reviewedBy ?? (value.type === "human" ? author : "")).trim();
	const reviewedAt = value.reviewedAt ?? fallbackReviewedAt;
	if (!reviewedBy || reviewedBy.length > 200 || !reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
		throw new Error("Human-reviewed research content requires a reviewer and review timestamp");
	}
	if (value.type === "ai-assisted" && reviewedBy.toLocaleLowerCase() === author.toLocaleLowerCase()) {
		throw new Error("The human reviewer must be distinct from the AI-assisted content author");
	}
	return {
		...value,
		author,
		model: value.model?.trim() || undefined,
		humanReviewed: true,
		reviewedBy,
		reviewedAt: new Date(reviewedAt).toISOString(),
	};
}

function boundedText(value: unknown, label: string, maximum = 200_000): string {
	if (typeof value !== "string" || value.length > maximum) throw new Error(`${label} must be a bounded string`);
	return value;
}

export function validateResearchRecord(input: ResearchRecord): ResearchRecord {
	if (
		!input ||
		typeof input !== "object" ||
		!["skim-card", "comparison-matrix", "evidence-graph"].includes(input.kind)
	)
		throw new Error("Research record kind is invalid");
	const base = {
		...input,
		id: safeSegment(input.id, "research record id"),
		title: boundedText(input.title, "title", 2_000).trim(),
		authorship: validateAuthorship(input.authorship, input.updatedAt),
	};
	if (!base.title) throw new Error("Research record title is required");
	if (input.kind === "skim-card") {
		if (!Array.isArray(input.sources) || input.sources.length > 10_000)
			throw new Error("A skim card requires a bounded source locator array");
		return {
			...base,
			kind: "skim-card",
			paperId: paperIdentifier(input.paperId),
			researchQuestion: boundedText(input.researchQuestion, "researchQuestion"),
			problem: boundedText(input.problem, "problem"),
			method: boundedText(input.method, "method"),
			datasets: boundedText(input.datasets, "datasets"),
			findings: boundedText(input.findings, "findings"),
			limitations: boundedText(input.limitations, "limitations"),
			unknowns: boundedText(input.unknowns, "unknowns"),
			sources: input.sources.map(validateSource),
		} as SkimCard;
	}
	if (input.kind === "comparison-matrix") {
		if (
			!Array.isArray(input.dimensions) ||
			input.dimensions.length === 0 ||
			input.dimensions.length > 100 ||
			!input.dimensions.every((item) => typeof item === "string" && item.trim() && item.length <= 200)
		)
			throw new Error("A comparison matrix needs 1-100 bounded dimensions");
		if (!Array.isArray(input.paperIds) || input.paperIds.length === 0 || input.paperIds.length > 500)
			throw new Error("A comparison matrix needs 1-500 paper ids");
		const cells: ComparisonMatrix["cells"] = {};
		const paperIds: string[] = [];
		for (const originalPaperId of input.paperIds) {
			const paperId = paperIdentifier(originalPaperId);
			if (!paperIds.includes(paperId)) paperIds.push(paperId);
			cells[paperId] ??= {};
			for (const dimension of input.dimensions) {
				const source = input.cells?.[originalPaperId]?.[dimension] ?? input.cells?.[paperId]?.[dimension];
				if (!source) continue;
				if (!Array.isArray(source.sources) || source.sources.length > 10_000)
					throw new Error("Comparison cell sources must be a bounded array");
				cells[paperId][dimension] = {
					value: boundedText(source.value, "comparison cell"),
					sources: (source.sources ?? []).map(validateSource),
					confidence: source.confidence,
				};
			}
		}
		return {
			...base,
			kind: "comparison-matrix",
			dimensions: [...new Set(input.dimensions.map((item) => item.trim()))],
			paperIds,
			cells,
		} as ComparisonMatrix;
	}
	if (
		!Array.isArray(input.cards) ||
		input.cards.length > 1_000 ||
		!Array.isArray(input.edges) ||
		input.edges.length > 5_000
	)
		throw new Error("Evidence graph exceeds configured limits");
	const cards = input.cards.map((card) => {
		if (!card || typeof card !== "object" || !Array.isArray(card.sources) || card.sources.length > 10_000)
			throw new Error("Every evidence card requires a bounded source locator array");
		return {
			id: safeSegment(card.id, "evidence card id"),
			claim: boundedText(card.claim, "claim"),
			stance: card.stance,
			evidence: boundedText(card.evidence, "evidence"),
			confidence: card.confidence,
			sources: card.sources.map(validateSource),
		};
	});
	if (
		!cards.every(
			(card) =>
				["support", "challenge", "unknown"].includes(card.stance) &&
				["high", "medium", "low"].includes(card.confidence),
		)
	)
		throw new Error("Evidence card stance or confidence is invalid");
	const cardIds = new Set(cards.map((card) => card.id));
	const edges = input.edges.map((edge) => {
		if (
			!cardIds.has(edge.from) ||
			!cardIds.has(edge.to) ||
			!["supports", "challenges", "depends-on", "contradicts"].includes(edge.relation)
		)
			throw new Error("Evidence edge is invalid");
		return edge;
	});
	return {
		...base,
		kind: "evidence-graph",
		question: boundedText(input.question, "question"),
		humanConclusion: boundedText(input.humanConclusion, "humanConclusion"),
		aiSuggestions: input.aiSuggestions === undefined ? undefined : boundedText(input.aiSuggestions, "aiSuggestions"),
		cards,
		edges,
	} as EvidenceGraph;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		try {
			await unlink(temporary);
		} catch {
			/* Preserve the write failure. */
		}
		throw error;
	}
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class ResearchWorkspace {
	readonly root: string;
	private auditChain: Promise<void> = Promise.resolve();
	private writeChain: Promise<void> = Promise.resolve();

	constructor(root: string) {
		this.root = resolve(root);
	}

	async initialize(): Promise<void> {
		await Promise.all(
			["skim-card", "comparison-matrix", "evidence-graph"].map((kind) =>
				mkdir(join(this.root, kind), { recursive: true }),
			),
		);
	}

	private path(kind: ResearchRecordKind, id: string): string {
		return join(this.root, kind, `${safeSegment(id, "research record id")}.json`);
	}

	async get(kind: ResearchRecordKind, id: string): Promise<ResearchRecord | undefined> {
		return readJson<ResearchRecord>(this.path(kind, id));
	}

	async list(kind?: ResearchRecordKind): Promise<ResearchRecord[]> {
		const kinds: ResearchRecordKind[] = kind ? [kind] : ["skim-card", "comparison-matrix", "evidence-graph"];
		const result: ResearchRecord[] = [];
		for (const selected of kinds) {
			const names = (await readdir(join(this.root, selected)).catch(() => [])).filter((name) => name.endsWith(".json"));
			for (const name of names) {
				const record = await readJson<ResearchRecord>(join(this.root, selected, name));
				if (record) result.push(record);
			}
		}
		return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async save(input: ResearchRecord): Promise<ResearchRecord> {
		await this.initialize();
		const validated = validateResearchRecord(input);
		let stored!: ResearchRecord;
		const write = async () => {
			const existing = await this.get(validated.kind, validated.id);
			if (existing?.authorship.type === "human" && validated.authorship.type === "ai-assisted") {
				throw new Error("AI-assisted content cannot overwrite a human-authored research record");
			}
			if (
				validated.kind === "evidence-graph" &&
				validated.authorship.type === "ai-assisted" &&
				existing?.kind === "evidence-graph" &&
				existing.humanConclusion !== validated.humanConclusion
			) {
				throw new Error("AI-assisted updates cannot change the human conclusion field");
			}
			const now = new Date().toISOString();
			stored = {
				...validated,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				revision: (existing?.revision ?? 0) + 1,
			} as ResearchRecord;
			await writeJsonAtomic(this.path(stored.kind, stored.id), stored);
			const event: ResearchAuditEvent = {
				id: `research-event-${randomUUID()}`,
				at: now,
				action: existing ? "update" : "create",
				recordKind: stored.kind,
				recordId: stored.id,
				author: stored.authorship.author,
				authorType: stored.authorship.type,
				humanReviewed: stored.authorship.humanReviewed,
				reviewedBy: stored.authorship.reviewedBy,
				revision: stored.revision,
			};
			this.auditChain = this.auditChain.then(async () => {
				await appendFile(join(this.root, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
			});
			await this.auditChain;
		};
		const operation = this.writeChain.then(write, write);
		this.writeChain = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
		return stored;
	}

	async audit(limit = 100): Promise<ResearchAuditEvent[]> {
		await this.auditChain;
		try {
			return (await readFile(join(this.root, "audit.jsonl"), "utf8"))
				.split(/\r?\n/)
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as ResearchAuditEvent];
					} catch {
						return [];
					}
				})
				.reverse()
				.slice(0, Math.min(Math.max(limit, 1), 500));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	toDerivedRecord(record: ResearchRecord): DerivedRecord {
		const sourceHashes =
			record.kind === "skim-card"
				? record.sources
						.flatMap((source) => [source.versionSha256, source.quoteSha256])
						.filter((hash): hash is string => Boolean(hash))
				: record.kind === "comparison-matrix"
					? Object.values(record.cells)
							.flatMap((row) =>
								Object.values(row).flatMap((cell) =>
									cell.sources.flatMap((source) => [source.versionSha256, source.quoteSha256]),
								),
							)
							.filter((hash): hash is string => Boolean(hash))
					: record.cards
							.flatMap((card) => card.sources.flatMap((source) => [source.versionSha256, source.quoteSha256]))
							.filter((hash): hash is string => Boolean(hash));
		const recordHash = normalizedHash(record);
		return {
			key: `research-${record.kind}-${record.id}-${recordHash.slice(0, 12)}`,
			paperId:
				record.kind === "skim-card"
					? record.paperId
					: record.kind === "comparison-matrix"
						? record.paperIds[0]
						: (record.cards[0]?.sources[0]?.paperId ?? "research-synthesis"),
			operation: record.kind,
			inputHashes: [...new Set(sourceHashes.length ? sourceHashes : [recordHash])],
			pipelineVersion: "research-workspace-v1",
			normalizedConfig: {
				humanReviewed: record.authorship.humanReviewed,
				authorType: record.authorship.type,
				reviewedBy: record.authorship.reviewedBy,
				reviewedAt: record.authorship.reviewedAt,
			},
			createdAt: record.updatedAt,
			createdBy: record.authorship.author,
			result: record,
		};
	}
}
