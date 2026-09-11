import type { PdfTranslationEngine } from "../../../config/domain/config-types.ts";
import type { OperationExecutionPermit, OperationPlan } from "../../../shared/application/operation-consent.ts";
import type { PdfTranslationRequest } from "../domain/pdf-translation-types.ts";

export interface AuthorizedPdfTranslationJob {
	request: PdfTranslationRequest;
	plan: OperationPlan;
	executionPermit: OperationExecutionPermit;
	engine: PdfTranslationEngine;
	modelKey: string;
	command: string;
}
