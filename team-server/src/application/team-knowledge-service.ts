import { FileTeamLiteratureRepository } from "../infrastructure/file-team-literature-repository.ts";
import { TeamKnowledgeStore } from "../infrastructure/team-knowledge-store.ts";

export type TeamKnowledgeService = TeamKnowledgeStore;

export function createTeamKnowledgeService(root: string, namespace: string): TeamKnowledgeService {
	return new TeamKnowledgeStore(root, namespace, new FileTeamLiteratureRepository(root, namespace));
}
