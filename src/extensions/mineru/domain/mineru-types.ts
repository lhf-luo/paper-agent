export interface MineruGenerationRequest {
	paperId: string;
	namespace: string;
	force: boolean;
}

export interface MineruConfiguration {
	baseUrl: string;
	apiKey: string;
	modelVersion: "pipeline" | "vlm";
	language: string;
}

export interface MineruJobCheckpoint {
	batchId: string;
	dataId: string;
	sourceSha256: string;
}

export interface MineruPackageManifest {
	schemaVersion: 1;
	engine: "mineru";
	sourceSha256: string;
	modelVersion: "pipeline" | "vlm";
	createdAt: string;
	pageCount: number;
	headings: Array<{ level: number; text: string; page: number }>;
	assets: Array<{ type: string; path?: string; caption?: string; page: number }>;
	files: string[];
}

export interface MineruStatus {
	configured: boolean;
	baseUrl: string;
	modelVersion: "pipeline" | "vlm";
	language: string;
	archiveExtractor?: "unzip" | "tar";
	available: boolean;
	reason?: string;
}
