export interface PdfRectangle {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PdfCoordinateMapperInput {
	analysisWidth: number;
	analysisHeight: number;
	displayWidth: number;
	displayHeight: number;
	rotation?: number;
}

export interface PdfCoordinateMapper {
	mode: "scaled" | "rotated";
	analysisWidth: number;
	analysisHeight: number;
	displayWidth: number;
	displayHeight: number;
	toDisplay: (rectangle: PdfRectangle) => PdfRectangle;
	toAnalysis: (rectangle: PdfRectangle) => PdfRectangle;
}

function normalizedRotation(rotation = 0): 0 | 90 | 180 | 270 {
	const value = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
	return value === 90 || value === 180 || value === 270 ? value : 0;
}

function dimensionsFit(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): boolean {
	const scaleX = targetWidth / sourceWidth;
	const scaleY = targetHeight / sourceHeight;
	return (
		Number.isFinite(scaleX) && Number.isFinite(scaleY) && Math.abs(scaleX - scaleY) <= Math.max(scaleX, scaleY) * 0.03
	);
}

function validateDimension(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
	return value;
}

function rotateRectangle(rectangle: PdfRectangle, width: number, height: number, rotation: 90 | 270): PdfRectangle {
	if (rotation === 90) {
		return {
			x: height - rectangle.y - rectangle.height,
			y: rectangle.x,
			width: rectangle.height,
			height: rectangle.width,
		};
	}
	return {
		x: rectangle.y,
		y: width - rectangle.x - rectangle.width,
		width: rectangle.height,
		height: rectangle.width,
	};
}

function unrotateRectangle(rectangle: PdfRectangle, width: number, height: number, rotation: 90 | 270): PdfRectangle {
	if (rotation === 90) {
		return {
			x: rectangle.y,
			y: height - rectangle.x - rectangle.width,
			width: rectangle.height,
			height: rectangle.width,
		};
	}
	return {
		x: width - rectangle.y - rectangle.height,
		y: rectangle.x,
		width: rectangle.height,
		height: rectangle.width,
	};
}

export function createPdfCoordinateMapper(input: PdfCoordinateMapperInput): PdfCoordinateMapper {
	const analysisWidth = validateDimension(input.analysisWidth, "analysisWidth");
	const analysisHeight = validateDimension(input.analysisHeight, "analysisHeight");
	const displayWidth = validateDimension(input.displayWidth, "displayWidth");
	const displayHeight = validateDimension(input.displayHeight, "displayHeight");
	const rotation = normalizedRotation(input.rotation);
	const directFit = dimensionsFit(analysisWidth, analysisHeight, displayWidth, displayHeight);
	const quarterTurn = rotation === 90 || rotation === 270;
	const rotatedFit = quarterTurn && dimensionsFit(analysisHeight, analysisWidth, displayWidth, displayHeight);
	const applyRotation = quarterTurn && !directFit && rotatedFit;
	const coordinateWidth = applyRotation ? analysisHeight : analysisWidth;
	const coordinateHeight = applyRotation ? analysisWidth : analysisHeight;
	const scaleX = displayWidth / coordinateWidth;
	const scaleY = displayHeight / coordinateHeight;

	return {
		mode: applyRotation ? "rotated" : "scaled",
		analysisWidth,
		analysisHeight,
		displayWidth,
		displayHeight,
		toDisplay(rectangle) {
			const oriented = applyRotation
				? rotateRectangle(rectangle, analysisWidth, analysisHeight, rotation as 90 | 270)
				: rectangle;
			return {
				x: oriented.x * scaleX,
				y: oriented.y * scaleY,
				width: oriented.width * scaleX,
				height: oriented.height * scaleY,
			};
		},
		toAnalysis(rectangle) {
			const oriented = {
				x: rectangle.x / scaleX,
				y: rectangle.y / scaleY,
				width: rectangle.width / scaleX,
				height: rectangle.height / scaleY,
			};
			return applyRotation
				? unrotateRectangle(oriented, analysisWidth, analysisHeight, rotation as 90 | 270)
				: oriented;
		},
	};
}
