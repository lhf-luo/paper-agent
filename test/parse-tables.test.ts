import { describe, expect, it } from "vitest";
import { parseLiteratureTables } from "../web/src/literature-markdown.ts";

const sample = `## 内核静态分析 / 漏洞检测
| 标题 | 年份/venue | 标识 |
| --- | --- | --- |
| [Enhancing Static Analysis for Practical Bug Detection](https://doi.org/10.1145/3649828) | PACMPL 2024 | 10.1145/3649828 |
| LR-Miner: Static Race Detection in OS Kernels | USENIX Sec 2024 | S2:03dda84b9f755a51d61046978f482e453a73d97c |

## 内核利用与缓解（exploitation & mitigation）
| 标题 | 年份/venue | 标识 |
| --- | --- | --- |
| [SLUBStick: Arbitrary Memory Writes via Cross-Cache Attacks](https://arxiv.org/abs/2310.13151) | USENIX Sec 2024 | arXiv:2310.13151 |`;
describe("parseLiteratureTables", () => {
	it("解析分组表格 + 链接单元格", () => {
		const parsed = parseLiteratureTables(sample);
		expect(parsed).not.toBeNull();
		expect(parsed!.tables).toHaveLength(2);
		const first = parsed!.tables[0];
		expect(first.focus).toContain("内核静态分析");
		expect(first.headers).toEqual(["标题", "年份/venue", "标识"]);
		expect(first.rows).toHaveLength(2);
		expect(first.rows[0][0]).toEqual({ text: "Enhancing Static Analysis for Practical Bug Detection", url: "https://doi.org/10.1145/3649828" });
		expect(first.rows[1][0]).toEqual({ text: "LR-Miner: Static Race Detection in OS Kernels", url: undefined });
		expect(parsed!.tables[1].rows).toHaveLength(1);
	});
	it("无表格返回 null", () => {
		expect(parseLiteratureTables("普通文本，没有表格")).toBeNull();
	});
});
