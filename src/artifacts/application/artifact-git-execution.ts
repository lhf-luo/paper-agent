import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";

function isRetryableGitTransportFailure(result: Awaited<ReturnType<CommandExecutor["exec"]>>): boolean {
	if (result.code === 0 || result.killed) return false;
	return /RPC failed|early EOF|unexpected disconnect|server closed abruptly|connection reset|promisor remote/i.test(
		result.stderr,
	);
}

export async function execGitWithTransportRetry(
	pi: CommandExecutor,
	args: string[],
	options: NonNullable<Parameters<CommandExecutor["exec"]>[2]>,
	maxAttempts: number,
	beforeRetry?: () => Promise<void>,
): Promise<Awaited<ReturnType<CommandExecutor["exec"]>>> {
	let result = await pi.exec("git", args, options);
	for (let attempt = 1; attempt < maxAttempts && isRetryableGitTransportFailure(result); attempt += 1) {
		await beforeRetry?.();
		result = await pi.exec("git", args, options);
	}
	return result;
}
