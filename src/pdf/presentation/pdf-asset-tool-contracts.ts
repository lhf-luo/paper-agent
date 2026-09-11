import { Type } from "typebox";
import type { EmbeddedImage } from "../application/pdf-assets.ts";
import type { PaperAsset, PdfBox } from "../domain/pdf-types.ts";

export interface InspectPdfLayoutDetails {
	path: string;
	pageCount: number;
	selectedPages: number[];
	granularity: "blocks" | "lines" | "words";
	itemCount: number;
	truncated: boolean;
}

export interface ExtractPdfRegionDetails {
	path: string;
	pageCount: number;
	page: number;
	assetId?: string;
	dpi: number;
	pageSize: { width: number; height: number };
	region: PdfBox;
	renderedPath: string;
	extractedCharacters: number;
	textTruncated: boolean;
	returnedImage: { mimeType: string; width: number; height: number; wasResized: boolean };
}

export interface ExtractPdfTableDetails extends ExtractPdfRegionDetails {
	rowCount: number;
	columnCount: number;
	columnAnchors: number[];
	usedExplicitBoundaries: boolean;
	warnings: string[];
}

export interface ListPaperAssetsDetails {
	path: string;
	pageCount: number;
	selectedPages: number[];
	assets: PaperAsset[];
	embeddedImages: EmbeddedImage[];
	truncated: boolean;
}

export const regionSchema = Type.Object({
	x: Type.Number({ minimum: 0, description: "Left edge" }),
	y: Type.Number({ minimum: 0, description: "Top edge" }),
	width: Type.Number({ exclusiveMinimum: 0, description: "Region width" }),
	height: Type.Number({ exclusiveMinimum: 0, description: "Region height" }),
});

export const coordinateSpaceSchema = Type.Optional(
	Type.Union([Type.Literal("points"), Type.Literal("normalized")], {
		description:
			'Coordinate space; "points" uses PDF points from the top-left (72 points/inch), "normalized" uses fractions in [0,1]; default: "points"',
	}),
);
