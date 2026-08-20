import { describe, expect, it } from "vitest";
import { parseLiteratureTables } from "../web/src/literature-markdown.ts";

const sample = `### B. 内核静态分析 / 漏洞检测
| 标题 | 年份/venue | 标识 |
|---|---|---|
| Enhancing Static Analysis for Practical Bug Detection: LLM-Integrated Approach | PACMPL 2024 | 10.1145/3649828 |
| LR-Miner: Static Race Detection in OS Kernels by Mining Locking Rules | USENIX Sec 2024 | S2:03dda84b9f755a51d61046978f482e453a73d97c |

### C. 内核利用与缓解（exploitation & mitigation）
| 标题 | 年份/venue | 标识 |
|---|---|---|
| SLUBStick: Arbitrary Memory Writes via Cross-Cache Attacks in Linux Kernel | USENIX Sec 2024 | S2:609e7baaea050ddbe97cacdbdca0ec683aff4daf |
| Take a Step Further: Understanding Page Spray in Linux Kernel Exploitation | USENIX Sec 2024 | arXiv:2406.02624 |

这是总结文本`;
describe("parseLiteratureTables", () => {
	it("解析分组表格", () => {
		const parsed = parseLiteratureTables(sample);
		expect(parsed).not.toBeNull();
		expect(parsed!.tables).toHaveLength(2);
		expect(parsed!.tables[0].focus).toContain("内核静态分析");
		expect(parsed!.tables[0].headers).toEqual(["标题", "年份/venue", "标识"]);
		expect(parsed!.tables[0].rows).toHaveLength(2);
		expect(parsed!.tables[0].rows[1][0]).toContain("LR-Miner");
		expect(parsed!.tables[1].focus).toContain("内核利用与缓解");
		expect(parsed!.tables[1].rows).toHaveLength(2);
		expect(parsed!.before).toContain("这是总结文本");
	});
	it("无表格返回 null", () => {
		expect(parseLiteratureTables("普通文本，没有表格")).toBeNull();
	});
});
