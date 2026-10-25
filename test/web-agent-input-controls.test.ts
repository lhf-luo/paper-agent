import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentInputControls } from "../web/src/agent-input-controls.tsx";

function sendButton(overrides: Partial<Parameters<typeof AgentInputControls>[0]> = {}) {
	const html = renderToStaticMarkup(createElement(AgentInputControls, {
		running: true, hasDraft: false, paused: false, disabled: true, stopping: false,
		delivery: "steer", onDelivery() {}, onSend() {}, onStop() {}, ...overrides,
	}));
	return html.match(/<button\b[^>]*class="agent-send-button"[^>]*>/)?.[0] ?? "";
}

describe("Agent composer primary action", () => {
	it("enables pause for an empty running composer even when sending is disabled", () => {
		const button = sendButton();
		expect(button).toContain('aria-label="暂停当前运行"');
		expect(button).not.toContain("disabled");
	});
	it("switches to the selected delivery mode when there is a draft", () => {
		expect(sendButton({ hasDraft: true, disabled: false })).toContain('aria-label="插话纠正"');
		expect(sendButton({ hasDraft: true, disabled: false, delivery: "followUp" })).toContain('aria-label="追加任务"');
	});
	it("prevents repeated pause requests and restores the idle send action", () => {
		expect(sendButton({ stopping: true })).toContain('aria-label="暂停中"');
		expect(sendButton({ stopping: true })).toContain("disabled");
		expect(sendButton({ running: false })).toContain('aria-label="发送"');
		expect(sendButton({ running: false })).toContain("disabled");
	});
});
