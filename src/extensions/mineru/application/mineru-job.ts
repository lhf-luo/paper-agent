import type { OperationExecutionPermit, OperationPlan } from "../../../shared/application/operation-consent.ts";
import type { MineruConfiguration, MineruGenerationRequest } from "../domain/mineru-types.ts";

export interface AuthorizedMineruJob {
	request: MineruGenerationRequest;
	source: {
		path: string;
		sha256: string;
		bytes: number;
		versionKind?: string;
	};
	configuration: Omit<MineruConfiguration, "apiKey">;
	plan: OperationPlan;
	executionPermit: OperationExecutionPermit;
}
