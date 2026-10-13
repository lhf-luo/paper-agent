import { spawn } from "node:child_process";

export interface CommandExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	detached?: boolean;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	maxOutputBytes?: number;
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
			const child = options.detached
				? spawn(command, args, {
						cwd: options.cwd,
						env: options.env ? { ...process.env, ...options.env } : undefined,
						windowsHide: false,
						shell: false,
						detached: true,
						stdio: "ignore",
					})
				: spawn(command, args, {
						cwd: options.cwd,
						env: options.env ? { ...process.env, ...options.env } : undefined,
						windowsHide: true,
						shell: false,
						stdio: ["ignore", "pipe", "pipe"],
					});
			const maxOutputBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
			let stdout: Buffer[] = [];
			let stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			const append = (chunks: Buffer[], bytes: number, chunk: Buffer): [Buffer[], number] => {
				if (!Number.isFinite(maxOutputBytes)) {
					chunks.push(chunk);
					return [chunks, bytes + chunk.length];
				}
				const combined = Buffer.concat([...chunks, chunk]);
				const tail = combined.subarray(Math.max(0, combined.length - maxOutputBytes));
				return [[tail], tail.length];
			};
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
			const observe = (callback: ((chunk: string) => void) | undefined, chunk: Buffer) => {
				try {
					callback?.(chunk.toString("utf8"));
				} catch (error) {
					if (settled) return;
					settled = true;
					cleanup();
					child.kill();
					reject(error);
				}
			};
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			});
			if (options.detached) {
				child.once("spawn", () => {
					if (settled) return;
					settled = true;
					cleanup();
					child.unref();
					resolve({ stdout: "", stderr: "", code: 0, killed: false });
				});
				return;
			}
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			if (options.timeout && options.timeout > 0) {
				timeout = setTimeout(() => {
					killed = true;
					child.kill();
				}, options.timeout);
			}
			child.stdout?.on("data", (chunk: Buffer) => {
				[stdout, stdoutBytes] = append(stdout, stdoutBytes, chunk);
				observe(options.onStdout, chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				[stderr, stderrBytes] = append(stderr, stderrBytes, chunk);
				observe(options.onStderr, chunk);
			});
			child.once("close", (code, signal) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve({
					stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
					stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
					code: code ?? (signal ? 1 : 0),
					killed,
				});
			});
		});
	}
}
