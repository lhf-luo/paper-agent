import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ModelPrompts } from "../scripts/model-prompts.ts";

function terminal() {
	const input = Object.assign(new PassThrough(), { isTTY: true });
	const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
	let text = "";
	output.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { input, prompts: new ModelPrompts(input, output), text: () => text };
}

describe("model credential prompt", () => {
	it("keeps the secret prompt visible and suppresses terminal echo and redraws", async () => {
		const { input, prompts, text } = terminal();
		try {
			const pending = prompts.askSecret("API key");
			expect(text()).toContain("API key");
			input.write("fixture-secret");
			expect(text()).not.toContain("fixture-secret");
			input.write("\r");
			expect(await pending).toBe("fixture-secret");
			expect(text()).not.toContain("fixture-secret");

			const selection = prompts.ask("Choose active model number", "1");
			input.write("2\r");
			expect(await selection).toBe("2");
			expect(text()).toContain("Choose active model number");
		} finally {
			prompts.close();
		}
	});

	it("re-prompts after an empty entry and waits for the next secret", async () => {
		const { input, prompts, text } = terminal();
		try {
			const pending = prompts.askSecret("API key");
			input.write("\r");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(text()).toContain("不能为空，请重新输入");
			input.write("replacement-fixture\r");
			expect(await pending).toBe("replacement-fixture");
			expect(text()).not.toContain("replacement-fixture");
		} finally {
			prompts.close();
		}
	});
});
