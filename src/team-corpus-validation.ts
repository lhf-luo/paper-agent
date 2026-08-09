export const teamNamespacePattern = "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$";

export function validateTeamNamespace(value: string): string {
	if (
		![".", ".."].includes(value) &&
		!value.endsWith(".") &&
		new RegExp(teamNamespacePattern).test(value) &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
	) {
		return value;
	}
	throw new Error("namespace must be a safe 1-64 character identifier");
}
