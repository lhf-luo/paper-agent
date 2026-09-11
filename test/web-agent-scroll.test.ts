import { describe, expect, it } from "vitest";
import { isAgentTranscriptNearBottom } from "../web/src/agent-scroll.ts";

describe("Web Agent transcript scrolling", () => {
	it("follows streaming output only while the reader remains near the bottom", () => {
		expect(isAgentTranscriptNearBottom({ scrollTop: 904, scrollHeight: 1_500, clientHeight: 500 })).toBe(true);
		expect(isAgentTranscriptNearBottom({ scrollTop: 700, scrollHeight: 1_500, clientHeight: 500 })).toBe(false);
	});
});
