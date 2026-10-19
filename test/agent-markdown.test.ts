import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import {
	agentMarkdownRehypePlugins,
	agentMarkdownRemarkPlugins,
	normalizeAgentMath,
} from "../web/src/agent-markdown.ts";

function render(content: string): string {
	return renderToStaticMarkup(
		createElement(
			ReactMarkdown,
			{ remarkPlugins: agentMarkdownRemarkPlugins, rehypePlugins: agentMarkdownRehypePlugins },
			normalizeAgentMath(content),
		),
	);
}

describe("Agent chat math rendering", () => {
	it("renders the reported reservoir answer with inline and display fractions", () => {
		const html = render(String.raw`把水池总容量看作 \(1\)。

甲管先开 \(2\) 小时，注入：
\[
2\times\frac16=\frac13
\]
还剩 \(1-\frac13=\frac23\)。

两管同时打开，每小时注入：
\[
\frac16+\frac18=\frac7{24}
\]
所以还需要：
\[
\frac23\div\frac7{24}=\boxed{\frac{16}{7}}\text{ 小时}
\]`);
		expect(html.match(/class="katex-display"/g)).toHaveLength(3);
		expect(html.match(/class="katex"/g)).toHaveLength(6);
		expect(html).toContain("<mfrac>");
		expect(html).toContain("<mn>16</mn>");
		expect(html).not.toContain("katex-error");
	});

	it("supports dollar delimiters and keeps GFM tables, links and emphasis", () => {
		const html = render(String.raw`**比较** [论文清单](/api/agent/results/example)

| 方法 | 复杂度 |
| --- | --- |
| A | \(O(n)\) |

$x^2$ 和

$$
\sum_{i=1}^n i
$$`);
		expect(html).toContain("<strong>比较</strong>");
		expect(html).toContain('href="/api/agent/results/example"');
		expect(html).toContain("<table>");
		expect(html.match(/class="katex"/g)).toHaveLength(3);
	});

	it("preserves inline code, fenced code and indented code verbatim", () => {
		const content = [String.raw`行内代码 \(x\)`, `${String.raw`双反引号 \[x\] 和 `}\``];
		const source = [
			`\`${content[0]}\``,
			`\`\`${content[1]} \`\``,
			"",
			"```latex",
			String.raw`\[\frac12\]`,
			"````",
			"",
			"~~~text",
			String.raw`\(y\)`,
			"~~~",
			"",
			String.raw`    \(z\)`,
		].join("\n");
		expect(normalizeAgentMath(source)).toBe(source);
		const html = render(source);
		expect(html).not.toContain('class="katex"');
		expect(html).toContain(String.raw`\frac12`);
	});

	it("does not convert escaped delimiters or unfinished streaming code fences", () => {
		for (const source of [String.raw`\\(literal\\)`, "```text\n\\[x\\]", "~~~\n\\(x\\)"]) {
			expect(normalizeAgentMath(source)).toBe(source);
			expect(render(source)).not.toContain('class="katex"');
		}
	});

	it("keeps formulas within numbered lists and blockquotes", () => {
		const html = render(String.raw`1. 计算：
   \[
   \frac{1}{2}
   \]
   然后验证。

2. \(x=1\)

> 公式 \[x^2\]
> 结论。`);
		expect(html.match(/<li>/g)).toHaveLength(2);
		expect(html.match(/class="katex-display"/g)).toHaveLength(2);
		expect(html).toMatch(/<li>[\s\S]*katex-display[\s\S]*然后验证。[\s\S]*<\/li>/);
		expect(html).toMatch(/<blockquote>[\s\S]*katex-display[\s\S]*<\/blockquote>/);
	});

	it("does not pair a math opener with delimiters inside code", () => {
		const source = `${String.raw`还未完成 \(，代码是 `}\`\\)\``;
		expect(normalizeAgentMath(source)).toBe(source);
	});

	it("accepts successive streaming fragments without exceptions", () => {
		const source = String.raw`计算：\[\frac{16}{7}\] 完成`;
		for (let end = 1; end <= source.length; end++) {
			expect(() => render(source.slice(0, end))).not.toThrow();
		}
		expect(render(source)).toContain('class="katex-display"');
	});

	it("keeps invalid TeX visible and blocks commands requiring trust", () => {
		expect(render(String.raw`\(\frac{1}\)`)).toContain("katex-error");
		const html = render(
			String.raw`\(\href{javascript:alert(1)}{unsafe}\) \(\includegraphics{https://example.com/image}\)`,
		);
		expect(html).not.toMatch(/<a(?:\s|>)/);
		expect(html).not.toContain("<img");
	});
});
