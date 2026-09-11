import { normalizedCaptionMatch } from "./pdf-caption.ts";

export function sectionHeading(text: string): boolean {
	const normalized = text.trim();
	if (!normalized || normalized.length > 120 || normalizedCaptionMatch(normalized)) return false;
	if (
		/^(?:abstract|introduction|background|related work|method(?:ology)?|experiments?|evaluation|results?|discussion|conclusion|references|appendix)\s*$/i.test(
			normalized,
		)
	) {
		return true;
	}
	if (/^(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][\p{L}\p{N}\s,:()/-]{2,100}$/u.test(normalized)) return true;
	return (
		normalized.length >= 4 &&
		normalized === normalized.toUpperCase() &&
		normalized !== normalized.toLowerCase() &&
		/[\p{L}]/u.test(normalized)
	);
}
