export interface PdfBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PaperAssetMention {
	page: number;
	matchedText: string;
	section?: string;
	context: string;
	lineBox: PdfBox;
	confidence: "high" | "ambiguous";
}

export interface PaperAsset {
	id: string;
	type: "figure" | "table" | "algorithm" | "listing";
	identifier: string;
	page: number;
	caption: string;
	captionBox: PdfBox;
	candidateRegion: PdfBox;
	continuationRegions?: Array<{ page: number; region: PdfBox; confidence: "high" | "medium" }>;
	subfigureRegions?: Array<{ label: string; region: PdfBox; confidence: "medium" | "low" }>;
	regionConfidence: "high" | "medium" | "low";
	mentions: PaperAssetMention[];
	manualCorrection?: { id: string; author: string; createdAt: string; note?: string };
}
