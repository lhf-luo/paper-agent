export interface OperationConfirmationSettings {
	requireAgentWriteConfirmation: boolean;
	requirePersonalLibraryWriteConfirmation: boolean;
	requirePersonalLibraryDeleteConfirmation: boolean;
	requireResearchConfirmation: boolean;
	requirePdfArtifactConfirmation: boolean;
	requireWikiWriteConfirmation: boolean;
}

export type OperationConfirmationOrigin = "agent" | "web";

export type MutatingOperationKind =
	| "artifact-acquisition"
	| "pdf-download"
	| "pdf-translation"
	| "pdf-material-generation"
	| "pdf-material-delete"
	| "personal-corpus-write"
	| "personal-collection-remove"
	| "team-write"
	| "team-proposal"
	| "team-review"
	| "configuration-write"
	| "external-api-probe"
	| "research-memory-write"
	| "research-memory-delete"
	| "wiki-write"
	| "personal-paper-remove"
	| "pdf-annotation-write"
	| "team-token-management"
	| "backup-restore"
	| "file-delete"
	| "file-move";

export const defaultOperationConfirmationSettings = (): OperationConfirmationSettings => ({
	requireAgentWriteConfirmation: false,
	requirePersonalLibraryWriteConfirmation: false,
	requirePersonalLibraryDeleteConfirmation: true,
	requireResearchConfirmation: true,
	requirePdfArtifactConfirmation: true,
	requireWikiWriteConfirmation: true,
});

export function requiresOperationConfirmation(
	kind: MutatingOperationKind,
	origin: OperationConfirmationOrigin,
	settings: OperationConfirmationSettings,
): boolean {
	switch (kind) {
		case "personal-corpus-write":
			return origin === "agent"
				? settings.requireAgentWriteConfirmation
				: settings.requirePersonalLibraryWriteConfirmation;
		case "personal-paper-remove":
		case "personal-collection-remove":
			return settings.requirePersonalLibraryDeleteConfirmation;
		case "research-memory-write":
		case "research-memory-delete":
			return settings.requireResearchConfirmation;
		case "wiki-write":
			return settings.requireWikiWriteConfirmation;
		case "artifact-acquisition":
		case "pdf-download":
		case "pdf-translation":
		case "pdf-material-generation":
		case "pdf-material-delete":
		case "pdf-annotation-write":
			return settings.requirePdfArtifactConfirmation;
		default:
			return true;
	}
}
