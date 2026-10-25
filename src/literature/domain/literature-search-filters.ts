export const SEARCH_FILTER_KEYS = ["yearFrom", "yearTo", "venues", "authors", "openAccess", "types"] as const;

export function assertSearchFilterKeys(filters: object): void {
	const allowed = new Set<string>(SEARCH_FILTER_KEYS);
	const unknown = Object.keys(filters).filter((key) => !allowed.has(key));
	if (unknown.length)
		throw new Error(
			`Unsupported search filter(s): ${unknown.join(", ")}; reissue the search using declared parameters`,
		);
}
