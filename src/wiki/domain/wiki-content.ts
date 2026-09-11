import type { WikiClaim } from "./wiki-types.ts";

const evidenceReference = /\[(E[1-9]\d*)\]/g;

export function evidenceIdsInMarkdown(markdown: string): string[] {
	return [...new Set([...markdown.matchAll(evidenceReference)].map((match) => match[1]))];
}

export function extractWikiClaims(markdown: string): WikiClaim[] {
	const claims: WikiClaim[] = [];
	for (const [index, rawLine] of markdown.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("<!--")) continue;
		const evidenceIds = [...new Set([...line.matchAll(evidenceReference)].map((match) => match[1]))];
		if (!evidenceIds.length) continue;
		claims.push({
			id: `C${claims.length + 1}`,
			text: line,
			evidenceIds,
			inferred: /\[推断\]|\[inferred\]/i.test(line),
			line: index + 1,
		});
	}
	return claims;
}

export function wikiLineDiff(before: string, after: string): string[] {
	const left = before.split(/\r?\n/);
	const right = after.split(/\r?\n/);
	if (before === after) return [];

	let prefix = 0;
	while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < left.length - prefix &&
		suffix < right.length - prefix &&
		left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
	) {
		suffix++;
	}
	const leftMiddle = left.slice(prefix, left.length - suffix);
	const rightMiddle = right.slice(prefix, right.length - suffix);
	const output = [`@@ -${prefix + 1},${leftMiddle.length} +${prefix + 1},${rightMiddle.length} @@`];
	for (const line of leftMiddle) output.push(`-${line}`);
	for (const line of rightMiddle) output.push(`+${line}`);
	return output;
}

export function normalizedWikiLabel(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function nearDuplicateLabels(left: string, right: string): boolean {
	const a = normalizedWikiLabel(left);
	const b = normalizedWikiLabel(right);
	if (!a || !b || a === b) return false;
	if (a.length < 8 || b.length < 8) return false;
	const grams = (value: string) => {
		const result = new Set<string>();
		for (let index = 0; index < value.length - 1; index++) result.add(value.slice(index, index + 2));
		return result;
	};
	const leftGrams = grams(a);
	const rightGrams = grams(b);
	let overlap = 0;
	for (const gram of leftGrams) if (rightGrams.has(gram)) overlap++;
	return (2 * overlap) / (leftGrams.size + rightGrams.size) >= 0.82;
}
