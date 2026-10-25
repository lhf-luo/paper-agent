/** The canvas owns its search workflow; global chats keep their corpus workflow. */
export const canvasExcludedSkills: readonly string[] = ["literature-corpus-manager"];
export function visibleSessionSkills<T extends { name: string }>(skills: T[], canvas: boolean): T[] {
	return canvas ? skills.filter((skill) => !canvasExcludedSkills.includes(skill.name)) : skills;
}
