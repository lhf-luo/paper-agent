import { describe, expect, it } from "vitest";
import { shouldRevealCredentialCard } from "../web/src/team-credentials.ts";

describe("team credential reveal", () => {
	it("scrolls the issued credential card into view when it renders outside the viewport", () => {
		// 管理员在页面下方签发凭据，卡片渲染在画布顶部，位于视口上方之外。
		expect(shouldRevealCredentialCard({ top: -684, bottom: -479 }, { height: 720 })).toBe(true);
		// 卡片在视口下方时同样需要带进来。
		expect(shouldRevealCredentialCard({ top: 800, bottom: 1005 }, { height: 720 })).toBe(true);
	});

	it("leaves the scroll position alone when the card is already fully visible", () => {
		expect(shouldRevealCredentialCard({ top: 100, bottom: 305 }, { height: 720 })).toBe(false);
		expect(shouldRevealCredentialCard({ top: 0, bottom: 720 }, { height: 720 })).toBe(false);
		// 部分露出仍算需要展示完整凭据。
		expect(shouldRevealCredentialCard({ top: -10, bottom: 195 }, { height: 720 })).toBe(true);
	});
});
