import { spawn } from "node:child_process";

export interface CommandExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
}

export interface CommandExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export interface CommandExecutor {
	exec(command: string, args: string[], options?: CommandExecOptions): Promise<CommandExecResult>;
}

export class NodeCommandExecutor implements CommandExecutor {
	async exec(command: string, args: string[], options: CommandExecOptions = {}): Promise<CommandExecResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd: options.cwd,
				windowsHide: true,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let killed = false;
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timeout) clearTimeout(timeout);
				options.signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				killed = true;
				child.kill();
			};
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			if (options.timeout && options.timeout > 0) {
				timeout = setTimeout(() => {
					killed = true;
					child.kill();
				}, options.timeout);
			}
			child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve({
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					code: code ?? (signal ? 1 : 0),
					killed,
				});
			});
		});
	}
}
