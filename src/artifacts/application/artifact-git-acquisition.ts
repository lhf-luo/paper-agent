import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
	ArtifactCandidate,
	ArtifactSnapshot,
	ArtifactSourceMetadata,
} from "../../literature/domain/literature-types.ts";
import type { CommandExecutor } from "../../shared/infrastructure/command-executor.ts";
import { assertPublicUrl } from "../../shared/infrastructure/network-address.ts";
import { artifactDirectoryNames, exists, isWithinRoot } from "./artifact-acquisition-files.ts";
import type { ArtifactNetworkOptions } from "./artifact-content.ts";
import { measureDirectoryUntil } from "./artifact-directory-size.ts";
import { sha256File } from "./artifact-discovery.ts";
import { execGitWithTransportRetry } from "./artifact-git-execution.ts";
import { requestedGitRefs } from "./artifact-git-refs.ts";
import { checkoutGitTree, restoreWindowsNtfsProtection } from "./artifact-git-worktree.ts";

const GIT_STAGE_TIMEOUT_MS = 10 * 60 * 1_000;

function repositoryUrl(candidate: ArtifactCandidate): URL {
	const source = new URL(candidate.url);
	if (source.protocol !== "https:") throw new Error("Git repositories must use public HTTPS URLs");
	source.search = "";
	source.hash = "";
	if (source.hostname.toLowerCase() === "github.com") {
		const parts = source.pathname.split("/").filter(Boolean);
		if (parts.length < 2) throw new Error("GitHub artifact URL does not identify a repository");
		source.pathname = `/${parts.slice(0, 2).join("/")}.git`;
	} else if (source.hostname.toLowerCase() === "gitlab.com") {
		const parts = source.pathname.split("/").filter(Boolean);
		const marker = parts.indexOf("-");
		const repositoryParts = marker >= 0 ? parts.slice(0, marker) : parts;
		if (repositoryParts.length < 2) throw new Error("GitLab artifact URL does not identify a repository");
		source.pathname = `/${repositoryParts.join("/").replace(/\.git$/i, "")}.git`;
	} else if (!source.pathname.endsWith(".git")) {
		source.pathname = `${source.pathname.replace(/\/+$/, "")}.git`;
	}
	return source;
}

async function inspectClone(
	pi: CommandExecutor,
	path: string,
	signal?: AbortSignal,
): Promise<Pick<ArtifactSnapshot, "branch" | "commit" | "remote" | "shallow" | "tag">> {
	const [commit, remote, branch, tag, shallow] = await Promise.all([
		pi.exec("git", ["-C", path, "rev-parse", "HEAD"], { signal, timeout: 15_000 }),
		pi.exec("git", ["-C", path, "remote", "get-url", "origin"], { signal, timeout: 15_000 }),
		pi.exec("git", ["-C", path, "branch", "--show-current"], { signal, timeout: 15_000 }),
		pi.exec("git", ["-C", path, "describe", "--tags", "--exact-match", "HEAD"], {
			signal,
			timeout: 15_000,
		}),
		pi.exec("git", ["-C", path, "rev-parse", "--is-shallow-repository"], { signal, timeout: 15_000 }),
	]);
	return {
		commit: commit.code === 0 ? commit.stdout.trim() : undefined,
		remote: remote.code === 0 ? remote.stdout.trim() : undefined,
		branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : undefined,
		tag: tag.code === 0 && tag.stdout.trim() ? tag.stdout.trim() : undefined,
		shallow: shallow.code === 0 ? shallow.stdout.trim() === "true" : undefined,
	};
}

export async function validateExistingSnapshot(
	pi: CommandExecutor,
	snapshot: ArtifactSnapshot,
	root: string,
	signal?: AbortSignal,
): Promise<{
	valid: boolean;
	reason?: string;
	evidence?: Pick<ArtifactSnapshot, "branch" | "commit" | "remote" | "shallow" | "tag">;
}> {
	if (!snapshot.localPath) return { valid: false, reason: "existing snapshot has no local path" };
	if (!isWithinRoot(root, snapshot.localPath)) {
		return { valid: false, reason: "existing snapshot path is outside this paper's artifact root" };
	}
	if (!(await exists(snapshot.localPath))) return { valid: false, reason: "existing snapshot path no longer exists" };
	if (snapshot.commit || snapshot.status === "cloned") {
		const evidence = await inspectClone(pi, snapshot.localPath, signal);
		if (!evidence.commit) return { valid: false, reason: "existing repository has no readable Git commit" };
		if (snapshot.commit && evidence.commit !== snapshot.commit) {
			return {
				valid: false,
				reason: `existing repository commit changed from ${snapshot.commit} to ${evidence.commit}`,
				evidence,
			};
		}
		if (snapshot.remote && evidence.remote !== snapshot.remote) {
			return { valid: false, reason: "existing repository origin no longer matches the manifest", evidence };
		}
		return { valid: true, evidence };
	}
	if (!snapshot.sha256) return { valid: false, reason: "existing downloaded snapshot has no SHA-256" };
	const actualSha256 = await sha256File(snapshot.localPath);
	if (actualSha256 !== snapshot.sha256) {
		return {
			valid: false,
			reason: `existing file SHA-256 mismatch: manifest=${snapshot.sha256} actual=${actualSha256}`,
		};
	}
	return { valid: true };
}

function normalizedRemote(value: string): string {
	return value
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

async function repositoryDestination(
	pi: CommandExecutor,
	root: string,
	candidate: ArtifactCandidate,
	remote: URL,
	signal?: AbortSignal,
): Promise<{ destination: string; evidence?: Awaited<ReturnType<typeof inspectClone>> }> {
	for (const name of artifactDirectoryNames(candidate)) {
		const destination = join(root, name);
		if (!(await exists(destination))) return { destination };
		const evidence = await inspectClone(pi, destination, signal);
		if (evidence.remote && normalizedRemote(evidence.remote) === normalizedRemote(remote.href)) {
			return { destination, evidence };
		}
	}
	throw new Error("artifact repository directory names conflict with existing repositories");
}

async function findLicenseFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
	while (pending.length && found.length < 30) {
		const current = pending.shift();
		if (!current) break;
		let entries: Dirent[];
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.isSymbolicLink()) continue;
			const path = join(current.path, entry.name);
			if (entry.isDirectory() && current.depth < 2) pending.push({ path, depth: current.depth + 1 });
			if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) found.push(path);
		}
	}
	return found;
}

export async function cloneRepository(
	pi: CommandExecutor,
	candidate: ArtifactCandidate,
	root: string,
	maxBytes: number,
	metadata: ArtifactSourceMetadata | undefined,
	metadataError: string | undefined,
	signal?: AbortSignal,
	network: Omit<ArtifactNetworkOptions, "signal"> = {},
): Promise<ArtifactSnapshot> {
	const url = repositoryUrl(candidate);
	const requestedRefs = requestedGitRefs(candidate);
	let requestedRef = requestedRefs[0];
	const resolvedAddresses = await assertPublicUrl(url, network.resolver);
	const gitNetworkOptions = [
		"-c",
		"credential.interactive=never",
		"-c",
		"credential.helper=",
		"-c",
		"core.askPass=",
		"-c",
		"filter.lfs.smudge=",
		"-c",
		"filter.lfs.required=false",
		"-c",
		"http.followRedirects=false",
		"-c",
		"http.sslVerify=true",
	];
	const resolvedDestination = await repositoryDestination(pi, root, candidate, url, signal);
	const destination = resolvedDestination.destination;
	if (await exists(destination)) {
		const usage = await measureDirectoryUntil(destination, maxBytes);
		if (usage.exceeded) {
			return {
				candidateId: candidate.id,
				sourceUrl: candidate.url,
				status: "failed",
				localPath: destination,
				retrievedAt: new Date().toISOString(),
				bytes: usage.bytes,
				failureReason: `existing repository exceeds the ${maxBytes} byte artifact limit`,
			};
		}
		const evidence = resolvedDestination.evidence ?? (await inspectClone(pi, destination, signal));
		return {
			candidateId: candidate.id,
			sourceUrl: candidate.url,
			status: "skipped",
			localPath: destination,
			retrievedAt: new Date().toISOString(),
			finalUrl: url.href,
			bytes: usage.bytes,
			requestedRef,
			resolvedAddresses,
			...evidence,
			metadata,
			metadataError,
			licenseFiles: await findLicenseFiles(destination),
			failureReason: "destination already exists; reused without network access",
		};
	}
	await mkdir(root, { recursive: true });
	const temporary = `${destination}.partial-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
	let result: Awaited<ReturnType<CommandExecutor["exec"]>>;
	try {
		result = await execGitWithTransportRetry(
			pi,
			[
				...gitNetworkOptions,
				"clone",
				"--depth",
				"1",
				"--filter=blob:none",
				"--single-branch",
				"--no-tags",
				"--no-checkout",
				url.href,
				temporary,
			],
			{ cwd: root, signal, timeout: GIT_STAGE_TIMEOUT_MS },
			2,
			() => rm(temporary, { recursive: true, force: true }),
		);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
	if (result.code !== 0 || result.killed || signal?.aborted) {
		await rm(temporary, { recursive: true, force: true });
		return {
			candidateId: candidate.id,
			sourceUrl: candidate.url,
			status: "failed",
			retrievedAt: new Date().toISOString(),
			finalUrl: url.href,
			resolvedAddresses,
			metadata,
			metadataError,
			failureReason: signal?.aborted
				? "operation aborted"
				: result.killed
					? "git clone timed out"
					: result.stderr.trim() || "git clone failed",
		};
	}
	let excludedCheckoutPaths: string[] = [];
	if (!requestedRefs.length) {
		const checkout = await checkoutGitTree(
			pi,
			temporary,
			"HEAD",
			gitNetworkOptions,
			["reset", "--hard", "HEAD"],
			GIT_STAGE_TIMEOUT_MS,
			signal,
		);
		excludedCheckoutPaths = checkout.excludedPaths;
		const checkedOut = checkout.result;
		if (checkedOut.code !== 0 || checkedOut.killed || signal?.aborted) {
			await rm(temporary, { recursive: true, force: true });
			return {
				candidateId: candidate.id,
				sourceUrl: candidate.url,
				status: "failed",
				retrievedAt: new Date().toISOString(),
				finalUrl: url.href,
				resolvedAddresses,
				metadata,
				metadataError,
				failureReason: checkedOut.killed
					? "git checkout timed out"
					: checkedOut.stderr.trim() || "git checkout failed",
			};
		}
	}
	if (requestedRefs.length) {
		let fetchedRef: Awaited<ReturnType<CommandExecutor["exec"]>> | undefined;
		for (const reference of requestedRefs) {
			fetchedRef = await pi.exec(
				"git",
				[...gitNetworkOptions, "-C", temporary, "fetch", "--depth", "1", "origin", reference],
				{ signal, timeout: GIT_STAGE_TIMEOUT_MS },
			);
			if (fetchedRef.code === 0 && !fetchedRef.killed && !signal?.aborted) {
				requestedRef = reference;
				break;
			}
		}
		if (!fetchedRef || fetchedRef.code !== 0 || fetchedRef.killed || signal?.aborted) {
			await rm(temporary, { recursive: true, force: true });
			return {
				candidateId: candidate.id,
				sourceUrl: candidate.url,
				status: "failed",
				retrievedAt: new Date().toISOString(),
				finalUrl: url.href,
				requestedRef,
				resolvedAddresses,
				metadata,
				metadataError,
				failureReason: fetchedRef?.killed
					? "git fetch for requested ref timed out"
					: fetchedRef?.stderr.trim() || "git fetch for requested ref failed",
			};
		}
		const checkout = await checkoutGitTree(
			pi,
			temporary,
			"FETCH_HEAD",
			gitNetworkOptions,
			["checkout", "--detach", "FETCH_HEAD"],
			GIT_STAGE_TIMEOUT_MS,
			signal,
		);
		excludedCheckoutPaths = checkout.excludedPaths;
		let checkedOut = checkout.result;
		if (excludedCheckoutPaths.length && checkedOut.code === 0 && !checkedOut.killed) {
			checkedOut = await pi.exec(
				"git",
				[...gitNetworkOptions, "-C", temporary, "update-ref", "--no-deref", "HEAD", "FETCH_HEAD"],
				{ signal, timeout: 15_000 },
			);
		}
		if (checkedOut.code !== 0 || checkedOut.killed || signal?.aborted) {
			await rm(temporary, { recursive: true, force: true });
			return {
				candidateId: candidate.id,
				sourceUrl: candidate.url,
				status: "failed",
				retrievedAt: new Date().toISOString(),
				finalUrl: url.href,
				requestedRef,
				resolvedAddresses,
				metadata,
				metadataError,
				failureReason: checkedOut.stderr.trim() || "git checkout for requested ref failed",
			};
		}
	}
	await restoreWindowsNtfsProtection(pi, temporary, excludedCheckoutPaths, signal);
	const usage = await measureDirectoryUntil(temporary, maxBytes);
	if (usage.exceeded) {
		await rm(temporary, { recursive: true, force: true });
		return {
			candidateId: candidate.id,
			sourceUrl: candidate.url,
			status: "failed",
			retrievedAt: new Date().toISOString(),
			finalUrl: url.href,
			requestedRef,
			resolvedAddresses,
			bytes: usage.bytes,
			metadata,
			metadataError,
			failureReason: `cloned repository exceeds the ${maxBytes} byte artifact limit`,
		};
	}
	try {
		await rename(temporary, destination);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
	const evidence = await inspectClone(pi, destination, signal);
	return {
		candidateId: candidate.id,
		sourceUrl: candidate.url,
		status: "cloned",
		localPath: destination,
		retrievedAt: new Date().toISOString(),
		finalUrl: url.href,
		requestedRef,
		bytes: usage.bytes,
		resolvedAddresses,
		...evidence,
		metadata: metadata ? { ...metadata, resolvedCommit: evidence.commit ?? metadata.resolvedCommit } : metadata,
		metadataError,
		licenseFiles: await findLicenseFiles(destination),
		excludedCheckoutPaths: excludedCheckoutPaths.length ? excludedCheckoutPaths : undefined,
	};
}
