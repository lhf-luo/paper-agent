import type { LiteratureProvider, PaperRecord } from "../domain/literature-types.ts";

export interface PdfMetadataWarning {
	stage: "pdfinfo" | "text" | "ocr" | "provider";
	message: string;
	provider?: LiteratureProvider;
}

export interface PdfMetadataNeedsReview {
	source: string;
	reason: "needs_metadata";
	missingFields: Array<"title" | "authors">;
	detail: string;
	warnings: PdfMetadataWarning[];
}

export interface ExtractedPdfMetadata {
	title?: string;
	authors: string[];
	year?: number;
	venue?: string;
	doi?: string;
	arxivId?: string;
	urls: string[];
	source: "pdfinfo" | "text" | "ocr";
	warnings: PdfMetadataWarning[];
}

export interface PreparedPdfImport {
	record?: PaperRecord;
	needsMetadata?: PdfMetadataNeedsReview;
	warnings: PdfMetadataWarning[];
	metadataSource?: ExtractedPdfMetadata["source"] | "doi";
}
