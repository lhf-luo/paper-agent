import { describe, expect, it } from "vitest";
import { cleanPaperText, cleanPaperTitle, paperTitleNeedsCleaning } from "../src/literature/domain/paper-title.ts";

describe("LaTeX in titles and abstracts", () => {
	it("converts the superscript-subscript LaTeX that arXiv returns", () => {
		expect(cleanPaperTitle(String.raw`$^{15}$C: from Halo-EFT structure to transfer reactions`)).toBe(
			"¹⁵C: from Halo-EFT structure to transfer reactions",
		);
		expect(cleanPaperText(String.raw`reactions involving $^{14}$C(d,p)$^{15}$C`)).toBe(
			"reactions involving ¹⁴C(d,p)¹⁵C",
		);
		expect(cleanPaperText(String.raw`rate of 10$^{-1}$ s$^{-1}$`)).toBe("rate of 10⁻¹ s⁻¹");
		// LaTeX often omits the braces around a single character.
		expect(cleanPaperText(String.raw`$^3$He and $^4$He`)).toBe("³He and ⁴He");
	});

	it("converts math symbols and escaped punctuation", () => {
		expect(cleanPaperText(String.raw`errors are $\pm$ 5%`)).toBe("errors are ± 5%");
		expect(cleanPaperText(String.raw`the $\gamma$ and $\mu$ channels`)).toBe("the γ and μ channels");
		expect(cleanPaperText(String.raw`x $\leq$ y $\times$ z`)).toBe("x ≤ y × z");
		expect(cleanPaperText(String.raw`Fast \& Safe: A Survey`)).toBe("Fast & Safe: A Survey");
		expect(cleanPaperText(String.raw`about 100\% of cases`)).toBe("about 100% of cases");
	});

	it("unwraps text-only commands and fractions", () => {
		expect(cleanPaperText(String.raw`Rethinking \emph{Secure} Boot`)).toBe("Rethinking Secure Boot");
		expect(cleanPaperText(String.raw`$\mathrm{H_2O}$ uptake`)).toBe("H₂O uptake");
		expect(cleanPaperText(String.raw`a ratio of $\frac{1}{2}$`)).toBe("a ratio of 1/2");
	});

	it("converts subscripts inside math but never in ordinary identifiers", () => {
		expect(cleanPaperText(String.raw`H$_2$O and CO$_2$`)).toBe("H₂O and CO₂");
		// The caret/underscore here is literal text; converting it would corrupt the title.
		expect(cleanPaperTitle("snake_case_identifier stays intact")).toBe("snake_case_identifier stays intact");
		expect(cleanPaperTitle("A 2^32 limit and an x_y axis")).toBe("A 2^32 limit and an x_y axis");
	});

	it("leaves plain text untouched and never returns empty", () => {
		expect(cleanPaperTitle("A Use-After-Free Vulnerability Detection Method")).toBe(
			"A Use-After-Free Vulnerability Detection Method",
		);
		// Nothing but math markup: cleaning would empty it, so the original is kept.
		expect(cleanPaperText("$$")).toBe("$$");
		expect(cleanPaperTitle(String.raw`$\quad$`)).toBe(String.raw`$\quad$`);
	});

	it("flags LaTeX titles as needing cleaning", () => {
		expect(paperTitleNeedsCleaning(String.raw`$^{15}$C: from Halo-EFT structure`)).toBe(true);
	});

	it("does not disturb an already-clean title containing an ampersand", () => {
		expect(cleanPaperTitle("Fast & Safe Kernel Fuzzing")).toBe("Fast & Safe Kernel Fuzzing");
	});
});

describe("cleanPaperTitle", () => {
	it("strips HTML tags, including ones exposed by entity decoding", () => {
		expect(
			cleanPaperTitle("<i>ECG</i>: Augmenting Embedded Operating System Fuzzing via LLM-Based Corpus Generation"),
		).toBe("ECG: Augmenting Embedded Operating System Fuzzing via LLM-Based Corpus Generation");
		expect(cleanPaperTitle("&lt;i&gt;ECG&lt;/i&gt;: Augmenting Embedded OS Fuzzing")).toBe(
			"ECG: Augmenting Embedded OS Fuzzing",
		);
		expect(cleanPaperTitle("&amp;lt;i&amp;gt;ECG&amp;lt;/i&amp;gt;: Double encoded")).toBe("ECG: Double encoded");
	});

	it("strips the researchgate boilerplate prefix", () => {
		expect(
			cleanPaperTitle(
				"See discussions, stats, and author profiles for this publication at: https://www.researchgate.net/publication/123 Deep Reinforcement Learning for Systems",
			),
		).toBe("Deep Reinforcement Learning for Systems");
	});

	it("strips publisher badges and file markers from the suffix", () => {
		expect(cleanPaperTitle("A Study of Static Analysis | SpringerLink")).toBe("A Study of Static Analysis");
		expect(cleanPaperTitle("Kernel Fuzzing at Scale - PDF")).toBe("Kernel Fuzzing at Scale");
		expect(cleanPaperTitle("Kernel Fuzzing at Scale.pdf")).toBe("Kernel Fuzzing at Scale");
		expect(cleanPaperTitle("Kernel Fuzzing at Scale PDF")).toBe("Kernel Fuzzing at Scale");
	});

	it("strips bare identifiers and export prefixes", () => {
		expect(cleanPaperTitle("arXiv:2405.12345 Fuzzing Embedded Operating Systems")).toBe(
			"Fuzzing Embedded Operating Systems",
		);
		expect(cleanPaperTitle("Fuzzing Embedded Operating Systems arXiv:2405.12345")).toBe(
			"Fuzzing Embedded Operating Systems",
		);
		expect(cleanPaperTitle("doi:10.1109/tcad.2024.3447220 Fuzzing Embedded Operating Systems")).toBe(
			"Fuzzing Embedded Operating Systems",
		);
		expect(cleanPaperTitle("Article in IEEE Transactions on Software Engineering")).toBe(
			"IEEE Transactions on Software Engineering",
		);
		expect(cleanPaperTitle("Preprint: Fuzzing Embedded Operating Systems")).toBe(
			"Fuzzing Embedded Operating Systems",
		);
	});

	it("applies stacked affixes until stable", () => {
		expect(cleanPaperTitle("Article in Fuzzing Embedded OS - PDF | SpringerLink")).toBe("Fuzzing Embedded OS");
	});

	it("normalizes unicode form, width and whitespace", () => {
		expect(cleanPaperTitle("  \uFF21\uFF22\u3000\u3000System   Security\u00a0 \n")).toBe("AB System Security");
		// NFKC folds the full-width vertical bar into ASCII, which is the point of the normalization.
		expect(cleanPaperTitle("\uff5cSpringerLink Fuzzing")).toBe("|SpringerLink Fuzzing");
		expect(cleanPaperTitle("Fuzzing Embedded Operating Systems\uff5cSpringerLink")).toBe(
			"Fuzzing Embedded Operating Systems",
		);
	});

	it("preserves legitimate subtitles, years and venue names", () => {
		const title = "A Case Study of LLM for Automated Vulnerability Repair: Assessing Impact of Reasoning (2024)";
		expect(cleanPaperTitle(title)).toBe(title);
		expect(cleanPaperTitle("Safe, Fast and Verified: A Survey of System Security")).toBe(
			"Safe, Fast and Verified: A Survey of System Security",
		);
		expect(cleanPaperTitle("IEEE Transactions on Software Engineering")).toBe(
			"IEEE Transactions on Software Engineering",
		);
	});

	it("never returns an empty title for non-empty input", () => {
		// Bare boilerplate cleans to nothing, so the original is kept rather than blanked out.
		expect(cleanPaperTitle("PDF")).toBe("PDF");
		expect(cleanPaperTitle("Preprint")).toBe("Preprint");
		expect(cleanPaperTitle("See discussions, stats, and author profiles for this publication at:")).toBe(
			"See discussions, stats, and author profiles for this publication at:",
		);
	});

	it("handles empty and whitespace-only input", () => {
		expect(cleanPaperTitle("")).toBe("");
		expect(cleanPaperTitle("   \n\t ")).toBe("");
		expect(cleanPaperTitle(undefined)).toBe("");
		expect(cleanPaperTitle(null)).toBe("");
	});

	it("decodes remaining entities in ordinary titles", () => {
		expect(cleanPaperTitle("Fast &amp; Safe Kernel Fuzzing")).toBe("Fast & Safe Kernel Fuzzing");
		expect(cleanPaperTitle("Rethinking &#39;Secure&#39; Boot")).toBe("Rethinking 'Secure' Boot");
	});
});

describe("paperTitleNeedsCleaning", () => {
	it("flags dirty titles", () => {
		expect(paperTitleNeedsCleaning("<i>ECG</i>: Augmenting OS Fuzzing")).toBe(true);
		expect(paperTitleNeedsCleaning("Kernel Fuzzing - PDF")).toBe(true);
		expect(paperTitleNeedsCleaning("Kernel Fuzzing\uff5cSpringerLink")).toBe(true);
	});

	it("leaves clean titles alone", () => {
		expect(paperTitleNeedsCleaning("A Case Study of LLM for Automated Vulnerability Repair")).toBe(false);
		expect(paperTitleNeedsCleaning("Safe, Fast and Verified: A Survey")).toBe(false);
	});
});
