export interface PdfMaterialRecord {
	id: string;
	namespace: string;
	paperId: string;
	paperVersionId: string;
	sourceSha256: string;
	relativePath: string;
	path: string;
	engine: "mineru";
	modelVersion: "pipeline" | "vlm";
	packageSha256: string;
	contentSha256: string;
	pageCount: number;
	fileCount: number;
	bytes: number;
	createdAt: string;
	updatedAt: string;
}

export type SavePdfMaterialInput = Omit<
	PdfMaterialRecord,
	"id" | "namespace" | "paperVersionId" | "path" | "createdAt" | "updatedAt"
>;
