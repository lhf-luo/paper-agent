import { createInterface } from "node:readline/promises";
import { type Readable, Writable } from "node:stream";

export class ModelPrompts {
	private readonly rl: ReturnType<typeof createInterface>;
	private readonly output: Writable & { isTTY?: boolean; columns?: number };
	private secret = false;

	constructor(input: Readable & { isTTY?: boolean }, output: Writable & { isTTY?: boolean; columns?: number }) {
		this.output = output;
		const promptOutput = new Writable({
			write: (chunk, encoding, callback) => {
				if (!this.secret) output.write(chunk, encoding);
				callback();
			},
		});
		Object.defineProperty(promptOutput, "columns", { get: () => output.columns });
		this.rl = createInterface({ input, output: promptOutput, terminal: Boolean(input.isTTY && output.isTTY) });
	}

	async ask(label: string, current = ""): Promise<string> {
		const suffix = current ? ` [${current}]` : "";
		const answer = (await this.rl.question(`${label}${suffix}: `)).trim();
		return answer || current;
	}

	async askSecret(label: string): Promise<string> {
		for (;;) {
			this.secret = true;
			try {
				// Hide readline's echo and redraws, then print the prompt on the real output.
				const pending = this.rl.question("");
				this.output.write(`${label}（输入不回显，粘贴后按 Enter）: `);
				const answer = (await pending).trim();
				this.output.write("\n");
				if (answer) return answer;
				this.output.write(`${label} 不能为空，请重新输入。\n`);
			} finally {
				this.secret = false;
			}
		}
	}

	close(): void {
		this.rl.close();
	}
}
