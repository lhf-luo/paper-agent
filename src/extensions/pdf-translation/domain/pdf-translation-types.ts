export type PdfTranslationOutputMode = "mono" | "dual";

export interface PdfTranslationRequest {
	paperId: string;
	namespace: string;
	sourceSha256: string;
	sourceLanguage: string;
	targetLanguage: string;
	outputMode: PdfTranslationOutputMode;
}

export interface PdfTranslationEngineStatus {
	available: boolean;
	engine: "pdf2zh-next";
	command: string;
	version?: string;
	activeModel?: string;
	reason?: string;
}

export interface PdfTranslationResult {
	paperId: string;
	namespace: string;
	sourceSha256: string;
	version: {
		sha256: string;
		bytes: number;
		blobPath: string;
		versionKind: "translation";
		versionLabel: string;
		retrievedAt: string;
	};
	engine: "pdf2zh-next";
	engineVersion?: string;
	model: string;
	outputMode: PdfTranslationOutputMode;
}
