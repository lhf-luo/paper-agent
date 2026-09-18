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

export interface MineruSectionIndex {
	id: string;
	title: string;
	level: number;
	startPage: number;
	endPage: number;
	blockRange: { start: number; end: number };
	markdownRange: { start: number; end: number };
}

export interface MineruAssetIndex {
	id: string;
	type: string;
	page: number;
	caption?: string;
	footnote?: string;
	path?: string;
	bbox?: number[];
	hasImage: boolean;
	hasStructuredContent: boolean;
	blockIndex: number;
}

export interface MineruPackageStatistics {
	pages: number;
	blockTypes: Record<string, number>;
	textBlocks: number;
	tables: number;
	figures: number;
	charts: number;
	codeBlocks: number;
}

export interface MineruPackageManifest {
	schemaVersion: 1 | 2;
	engine: "mineru";
	sourceSha256: string;
	modelVersion: "pipeline" | "vlm";
	createdAt: string;
	pageCount: number;
	headings: Array<{ level: number; text: string; page: number }>;
	assets: Array<{
		id?: string;
		type: string;
		path?: string;
		caption?: string;
		footnote?: string;
		page: number;
		bbox?: number[];
		hasImage?: boolean;
		hasStructuredContent?: boolean;
		blockIndex?: number;
	}>;
	sections?: MineruSectionIndex[];
	statistics?: MineruPackageStatistics;
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
