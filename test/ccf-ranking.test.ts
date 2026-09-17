import { describe, expect, it } from "vitest";
import { ccfLevelLabel, lookupCcfLevel } from "../src/literature/infrastructure/ccf-ranking.ts";

describe("CCF venue ranking lookup", () => {
	it("优先按缩写精确匹配会议", () => {
		expect(lookupCcfLevel("OSDI")).toBe("A");
		expect(lookupCcfLevel("SOSP")).toBe("A");
		expect(lookupCcfLevel("ICSE")).toBe("A");
		expect(lookupCcfLevel("ISSTA")).toBe("A");
		expect(lookupCcfLevel("CVPR")).toBe("A");
		expect(lookupCcfLevel("NeurIPS")).toBe("A");
	});

	it("缩写同时对应会议和期刊时取会议", () => {
		// WWW 既是会议(International World Wide Web Conference) 也是期刊(World Wide Web)。
		expect(lookupCcfLevel("WWW")).toBe("A");
		expect(lookupCcfLevel("CSCW")).toBe("A");
		expect(lookupCcfLevel("ASE")).toBe("A");
		// TCC 既是期刊(IEEE Transactions on Cloud Computing) 也是会议(Theory of Cryptography)。
		expect(lookupCcfLevel("TCC")).toBe("B");
	});

	it("缩写冲突时按 venue 文本里的全称线索选择", () => {
		// ESEC/FSE 是软件工程旗舰(A), Fast Software Encryption 是对称密码会议(B), 同用 FSE。
		expect(lookupCcfLevel("FSE")).toBe("A");
		expect(lookupCcfLevel("ESEC/FSE")).toBe("A");
		expect(lookupCcfLevel("ESEC/SIGSOFT FSE")).toBe("A");
		expect(lookupCcfLevel("Fast Software Encryption")).toBe("B");
		expect(lookupCcfLevel("FSE (Fast Software Encryption)")).toBe("B");
	});

	it("识别常见写法别名", () => {
		expect(lookupCcfLevel("NIPS")).toBe("A");
		expect(lookupCcfLevel("IEEE S&P")).toBe("A");
		expect(lookupCcfLevel("Oakland")).toBe("A");
		expect(lookupCcfLevel("KDD")).toBe("A");
		// CCF 目录里 ATC 的缩写是 ACM SIGOPS。
		expect(lookupCcfLevel("ATC")).toBe("A");
		expect(lookupCcfLevel("USENIX ATC")).toBe("A");
	});

	it("匹配全称并容忍年份、届次与作者页前缀", () => {
		expect(lookupCcfLevel("IEEE Symposium on Security and Privacy")).toBe("A");
		expect(lookupCcfLevel("USENIX Security Symposium 2023")).toBe("A");
		expect(lookupCcfLevel("SC 2023")).toBe("A");
		expect(lookupCcfLevel("Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition")).toBe(
			"A",
		);
		expect(lookupCcfLevel("Proceedings of the 46th International Conference on Software Engineering (ICSE)")).toBe(
			"A",
		);
		expect(lookupCcfLevel("Proc. IEEE INFOCOM 2023")).toBe("A");
	});

	it("短全称不会劫持更长的 venue 字符串", () => {
		// "Proceedings of the IEEE" 是 A 类期刊, 但它同时是 CVPR 全称的前缀。
		expect(lookupCcfLevel("Proceedings of the IEEE")).toBe("A");
		expect(lookupCcfLevel("Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition")).toBe("A");
	});

	it("期刊缩写与全称均可识别", () => {
		expect(lookupCcfLevel("TSE")).toBe("A");
		expect(lookupCcfLevel("TDSC")).toBe("A");
		expect(lookupCcfLevel("TIFS")).toBe("A");
		expect(lookupCcfLevel("JMLR")).toBe("A");
		expect(lookupCcfLevel("IEEE Transactions on Software Engineering")).toBe("A");
		expect(lookupCcfLevel("Journal of Machine Learning Research")).toBe("A");
	});

	it("收录修复过的畸形条目", () => {
		// 这些条目原先的缩写带有尾随分隔符或内部空格, 导致完全无法匹配。
		expect(lookupCcfLevel("SIGMETRICS")).toBe("B");
		expect(lookupCcfLevel("INTERSPEECH")).toBe("B");
		expect(lookupCcfLevel("ACM MM")).toBe("A");
		expect(lookupCcfLevel("IEEE VIS")).toBe("A");
		expect(lookupCcfLevel("HotStorage")).toBe("C");
		// 全称原先被截断或被重复词污染。
		expect(lookupCcfLevel("Expert Systems")).toBe("C");
		expect(lookupCcfLevel("IEEE/RSJ International Conference on Intelligent Robots and Systems")).toBe("C");
	});

	it("非 CCF 收录或无法确认的 venue 返回 undefined", () => {
		expect(lookupCcfLevel("arXiv preprint")).toBeUndefined();
		expect(lookupCcfLevel("IEEE Access")).toBeUndefined();
		expect(lookupCcfLevel("Communications of the ACM")).toBeUndefined();
		expect(lookupCcfLevel("")).toBeUndefined();
		expect(lookupCcfLevel(undefined)).toBeUndefined();
	});

	it("生成徽章标签", () => {
		expect(ccfLevelLabel("A")).toBe("CCF-A");
		expect(ccfLevelLabel("B")).toBe("CCF-B");
		expect(ccfLevelLabel("C")).toBe("CCF-C");
	});
	it("不会把主会 workshop、poster 或 demo 误标成主会等级", () => {
		expect(lookupCcfLevel("CVPR workshop")).toBeUndefined();
		expect(lookupCcfLevel("ICML Poster")).toBeUndefined();
		expect(lookupCcfLevel("SIGMOD demo")).toBeUndefined();
		expect(lookupCcfLevel("Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshop")).toBeUndefined();
		// CCF 目录本身明确收录的 workshop 仍然可以匹配。
		expect(lookupCcfLevel("HotOS")).toBe("B");
		expect(lookupCcfLevel("USENIX Workshop on Hot Topics in Operating Systems")).toBe("B");
	});

	it("利用期刊/会议上下文消歧，无法消歧时返回 undefined", () => {
		expect(lookupCcfLevel("WWW Journal")).toBe("B");
		expect(lookupCcfLevel("ASE Journal")).toBe("B");
		expect(lookupCcfLevel("Computational Visual Media")).toBeUndefined();
		expect(lookupCcfLevel("Computational Visual Media Journal")).toBe("B");
		expect(lookupCcfLevel("Computational Visual Media Conference")).toBe("C");
	});

});
