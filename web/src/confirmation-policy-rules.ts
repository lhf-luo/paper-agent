import type { OperationConfirmationSettingsView } from "./types";

export function requiresWebOperationConfirmation(kind: string, settings: OperationConfirmationSettingsView): boolean {
	switch (kind) {
		case "personal-corpus-write":
			return settings.requirePersonalLibraryWriteConfirmation;
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
