import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PaperAsset, PdfBox } from "./pdf-asset-tools.ts";

export interface PdfAssetCorrection {
	id: string;
	pdfSha256: string;
	assetId: string;
	page: number;
	originalRegion: PdfBox;
	correctedRegion: PdfBox;
	subfigureRegions?: Array<{ label: string; region: PdfBox }>;
	note?: string;
	author: string;
	createdAt: string;
}

interface PdfCorrectionFile {
	schemaVersion: 1;
	pdfSha256: string;
	updatedAt: string;
	corrections: PdfAssetCorrection[];
}

function validBox(box: PdfBox, label: string): PdfBox {
	if (
		!box ||
		![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
		box.x < 0 ||
		box.y < 0 ||
		box.width <= 0 ||
		box.height <= 0 ||
		box.width > 100_000 ||
		box.height > 100_000
	)
		throw new Error(`${label} is invalid`);
	return { x: box.x, y: box.y, width: box.width, height: box.height };
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
			/* Preserve the write error. */
		}
		throw error;
	}
}

export class PdfAnnotationStore {
	readonly root: string;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(root: string) {
		this.root = resolve(root);
	}

	private path(pdfSha256: string): string {
		if (!/^[a-f0-9]{64}$/i.test(pdfSha256)) throw new Error("PDF SHA-256 is invalid");
		return join(this.root, `${pdfSha256.toLowerCase()}.json`);
	}

	async list(pdfSha256: string): Promise<PdfAssetCorrection[]> {
		try {
			const parsed = JSON.parse(await readFile(this.path(pdfSha256), "utf8")) as PdfCorrectionFile;
			if (
				parsed.schemaVersion !== 1 ||
				parsed.pdfSha256 !== pdfSha256.toLowerCase() ||
				!Array.isArray(parsed.corrections)
			)
				throw new Error("PDF correction file is invalid");
			return parsed.corrections;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async save(input: Omit<PdfAssetCorrection, "id" | "createdAt">): Promise<PdfAssetCorrection> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.assetId)) throw new Error("Asset id is invalid");
		if (!Number.isInteger(input.page) || input.page < 1) throw new Error("Asset page is invalid");
		if (!input.author.trim()) throw new Error("Correction author is required");
		const correction: PdfAssetCorrection = {
			...input,
			pdfSha256: input.pdfSha256.toLowerCase(),
			originalRegion: validBox(input.originalRegion, "originalRegion"),
			correctedRegion: validBox(input.correctedRegion, "correctedRegion"),
			subfigureRegions: input.subfigureRegions?.map((entry) => ({
				label: entry.label.slice(0, 50),
				region: validBox(entry.region, "subfigure region"),
			})),
			note: input.note?.trim().slice(0, 10_000) || undefined,
			author: input.author.trim().slice(0, 200),
			id: `pdf-correction-${randomUUID()}`,
			createdAt: new Date().toISOString(),
		};
		const write = async () => {
			const existing = await this.list(correction.pdfSha256);
			const file: PdfCorrectionFile = {
				schemaVersion: 1,
				pdfSha256: correction.pdfSha256,
				updatedAt: correction.createdAt,
				corrections: [...existing, correction],
			};
			await writeJsonAtomic(this.path(correction.pdfSha256), file);
			await mkdir(this.root, { recursive: true });
			await appendFile(
				join(this.root, "audit.jsonl"),
				`${JSON.stringify({ at: correction.createdAt, action: "pdf.asset.correct", correctionId: correction.id, pdfSha256: correction.pdfSha256, assetId: correction.assetId, author: correction.author })}\n`,
				"utf8",
			);
		};
		const operation = this.writeChain.then(write, write);
		this.writeChain = operation.then(
			() => undefined,
			() => undefined,
		);
		await operation;
		return correction;
	}

	async apply(pdfSha256: string, assets: PaperAsset[]): Promise<PaperAsset[]> {
		const latest = new Map<string, PdfAssetCorrection>();
		for (const correction of await this.list(pdfSha256)) latest.set(correction.assetId, correction);
		return assets.map((asset) => {
			const correction = latest.get(asset.id);
			if (!correction) return asset;
			return {
				...asset,
				candidateRegion: correction.correctedRegion,
				subfigureRegions:
					correction.subfigureRegions?.map((entry) => ({ ...entry, confidence: "medium" as const })) ??
					asset.subfigureRegions,
				regionConfidence: "high" as const,
				manualCorrection: {
					id: correction.id,
					author: correction.author,
					createdAt: correction.createdAt,
					note: correction.note,
				},
			} as PaperAsset;
		});
	}
}
