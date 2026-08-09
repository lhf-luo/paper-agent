import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
	type ArtifactNetworkOptions,
	inspectArtifactContent,
	resolveArtifactSourceMetadata,
} from "./artifact-content.ts";
import { sha256File } from "./artifact-discovery.ts";
import type { CommandExecutor } from "./command-executor.ts";
import type {
	ArtifactCandidate,
	ArtifactManifest,
	ArtifactSnapshot,
	ArtifactSourceFile,
	ArtifactSourceMetadata,
} from "./literature-types.ts";
import { assertPublicUrl, fetchPublicUrl, readResponseBody, safeDownloadName } from "./network-security.ts";
import {
	authorizeOperationExecution,
	type OperationExecutionAuthorization,
	type OperationPlan,
} from "./operation-consent.ts";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isWithinRoot(root: string, path: string): boolean {
	const relativePath = relative(resolve(root), resolve(path));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = path + "." + randomUUID() + ".tmp";
	await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}

async function readExistingManifest(path: string, pdfSha256: string): Promise<ArtifactManifest | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as ArtifactManifest).schemaVersion === 1 &&
			(parsed as ArtifactManifest).pdfSha256 === pdfSha256 &&
			Array.isArray((parsed as ArtifactManifest).acquisitions)
		) {
			return parsed as ArtifactManifest;
		}
		return undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function acquisitionRoot(manifest: ArtifactManifest): string {
	const stem = basename(manifest.pdfPath, extname(manifest.pdfPath))
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.slice(0, 80);
	return join(dirname(manifest.pdfPath), "artifacts", stem + "-" + manifest.pdfSha256.slice(0, 12));
}

function repositoryUrl(candidate: ArtifactCandidate): URL {
	const source = new URL(candidate.url);
	if (source.protocol !== "https:") throw new Error("Git repositories must use public HTTPS URLs");
	source.search = "";
	source.hash = "";
	if (source.hostname.toLowerCase() === "github.com") {
		const parts = source.pathname.split("/").filter(Boolean);
		if (parts.length < 2) throw new Error("GitHub artifact URL does not identify a repository");
		source.pathname = "/" + parts.slice(0, 2).join("/") + ".git";
	} else if (source.hostname.toLowerCase() === "gitlab.com") {
		const parts = source.pathname.split("/").filter(Boolean);
		const marker = parts.indexOf("-");
		const repositoryParts = marker >= 0 ? parts.slice(0, marker) : parts;
		if (repositoryParts.length < 2) throw new Error("GitLab artifact URL does not identify a repository");
		source.pathname = "/" + repositoryParts.join("/").replace(/\.git$/i, "") + ".git";
	} else if (!source.pathname.endsWith(".git")) {
		source.pathname = source.pathname.replace(/\/+$/, "") + ".git";
	}
	return source;
}

function artifactDirectoryName(candidate: ArtifactCandidate): string {
	const url = new URL(candidate.url);
	const pathName = url.pathname
		.split("/")
		.filter(Boolean)
		.slice(-2)
		.join("-")
		.replace(/\.git$/i, "");
	return (candidate.host + "-" + (pathName || candidate.id)).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
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

async function validateExistingSnapshot(
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

function requestedGitRefs(candidate: ArtifactCandidate): string[] {
	const sourceUrl = [
		candidate.url,
		...candidate.sources.map((source) => source.url).filter((url): url is string => Boolean(url)),
	]
		.flatMap((value) => {
			try {
				return [new URL(value)];
			} catch {
				return [];
			}
		})
		.find((url) => {
			const parts = url.pathname.split("/").filter(Boolean);
			return url.hostname.toLowerCase() === "github.com"
				? ["commit", "releases", "tree"].includes(parts[2] ?? "")
				: url.hostname.toLowerCase() === "gitlab.com" && parts.includes("-");
		});
	const url = sourceUrl ?? new URL(candidate.url);
	const host = url.hostname.toLowerCase();
	const parts = url.pathname.split("/").filter(Boolean);
	let value: string | undefined;
	let treeReference = false;
	if (host === "github.com") {
		if (parts[2] === "commit" && parts[3]) value = parts[3];
		else if (parts[2] === "releases" && parts[3] === "tag" && parts[4]) value = parts.slice(4).join("/");
		else if (parts[2] === "tree" && parts[3]) {
			value = parts.slice(3).join("/");
			treeReference = true;
		}
	} else if (host === "gitlab.com") {
		const marker = parts.indexOf("-");
		const action = marker >= 0 ? parts[marker + 1] : undefined;
		if (action === "commit" && parts[marker + 2]) value = parts[marker + 2];
		else if ((action === "tree" || action === "tags") && parts[marker + 2]) {
			value = parts.slice(marker + 2).join("/");
			treeReference = action === "tree";
		}
	} else return [];
	if (!value) return [];
	const decoded = decodeURIComponent(value);
	if (
		decoded.length > 200 ||
		decoded.startsWith("-") ||
		decoded.includes("..") ||
		/[\u0000-\u0020~^:?*\\[\]]/.test(decoded)
	) {
		throw new Error("Git reference in artifact URL is unsafe or malformed");
	}
	if (!treeReference) return [decoded];
	const segments = decoded.split("/");
	return segments.map((_, index) => segments.slice(0, segments.length - index).join("/"));
}

function normalizedRemote(value: string): string {
	return value
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "")
		.toLowerCase();
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

async function cloneRepository(
	pi: CommandExecutor,
	candidate: ArtifactCandidate,
	root: string,
	metadata: ArtifactSourceMetadata | undefined,
	metadataError: string | undefined,
	signal?: AbortSignal,
	network: Omit<ArtifactNetworkOptions, "signal"> = {},
): Promise<ArtifactSnapshot> {
	const url = repositoryUrl(candidate);
	const requestedRefs = requestedGitRefs(candidate);
	let requestedRef = requestedRefs[0];
	const resolvedAddresses = await assertPublicUrl(url, network.resolver);
	const pinnedAddress = resolvedAddresses[0];
	if (!pinnedAddress) throw new Error("Git repository host has no verified public address");
	const curlResolve = `${url.hostname}:443:${pinnedAddress.includes(":") ? `[${pinnedAddress}]` : pinnedAddress}`;
	const platformTls = process.platform === "win32" ? ["-c", "http.sslBackend=schannel"] : [];
	const destination = join(root, artifactDirectoryName(candidate));
	if (await exists(destination)) {
		const evidence = await inspectClone(pi, destination, signal);
		if (evidence.remote && normalizedRemote(evidence.remote) !== normalizedRemote(url.href)) {
			throw new Error("existing repository origin does not match the requested artifact URL");
		}
		return {
			candidateId: candidate.id,
			sourceUrl: candidate.url,
			status: "skipped",
			localPath: destination,
			retrievedAt: new Date().toISOString(),
			finalUrl: url.href,
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
	const temporary = destination + ".partial-" + randomUUID();
	let result: Awaited<ReturnType<CommandExecutor["exec"]>>;
	try {
		result = await pi.exec(
			"git",
			[
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
				...platformTls,
				"-c",
				`http.curloptResolve=${curlResolve}`,
				"clone",
				"--depth",
				"1",
				"--filter=blob:none",
				"--single-branch",
				"--no-tags",
				url.href,
				temporary,
			],
			{ cwd: root, signal, timeout: 180_000 },
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
	if (requestedRefs.length) {
		let fetchedRef: Awaited<ReturnType<CommandExecutor["exec"]>> | undefined;
		for (const reference of requestedRefs) {
			fetchedRef = await pi.exec(
				"git",
				[
					"-c",
					"http.followRedirects=false",
					"-c",
					"http.sslVerify=true",
					...platformTls,
					"-c",
					`http.curloptResolve=${curlResolve}`,
					"-C",
					temporary,
					"fetch",
					"--depth",
					"1",
					"origin",
					reference,
				],
				{ signal, timeout: 180_000 },
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
		const checkedOut = await pi.exec("git", ["-C", temporary, "checkout", "--detach", "FETCH_HEAD"], {
			signal,
			timeout: 30_000,
		});
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
		resolvedAddresses,
		...evidence,
		metadata: metadata ? { ...metadata, resolvedCommit: evidence.commit ?? metadata.resolvedCommit } : metadata,
		metadataError,
		licenseFiles: await findLicenseFiles(destination),
	};
}

async function downloadArtifact(
	candidate: ArtifactCandidate,
	root: string,
	maxBytes: number,
	metadata: ArtifactSourceMetadata | undefined,
	metadataError: string | undefined,
	metadataFile?: ArtifactSourceFile,
	signal?: AbortSignal,
	network: Omit<ArtifactNetworkOptions, "signal"> = {},
): Promise<ArtifactSnapshot> {
	if (metadataFile?.bytes !== undefined && metadataFile.bytes > maxBytes) {
		throw new Error(`artifact metadata declares ${metadataFile.bytes} bytes, above the ${maxBytes} byte limit`);
	}
	const requested = new URL(candidate.url);
	if (requested.protocol !== "https:") throw new Error("Artifact downloads must use public HTTPS URLs");
	const fetched = await fetchPublicUrl(requested, { signal, ...network, requireHttps: true });
	if (!fetched.response.ok) throw new Error("HTTP " + fetched.response.status);
	const body = await readResponseBody(fetched.response, maxBytes);
	if (metadataFile?.bytes !== undefined && metadataFile.bytes !== body.length) {
		throw new Error(
			`artifact size does not match source metadata: expected=${metadataFile.bytes} actual=${body.length}`,
		);
	}
	if (metadataFile?.checksum) {
		const declared = metadataFile.checksum.trim().toLowerCase();
		const separator = declared.indexOf(":");
		const normalizedAlgorithm = separator >= 0 ? declared.slice(0, separator).replaceAll("-", "") : undefined;
		const algorithm =
			normalizedAlgorithm ??
			({ 32: "md5", 40: "sha1", 64: "sha256", 128: "sha512" } as Record<number, string>)[declared.length];
		const expected = separator >= 0 ? declared.slice(separator + 1) : declared;
		const expectedLengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };
		if (
			!algorithm ||
			!expectedLengths[algorithm] ||
			!new RegExp(`^[a-f0-9]{${expectedLengths[algorithm]}}$`).test(expected)
		) {
			throw new Error(`artifact metadata declares an unsupported or malformed checksum: ${metadataFile.checksum}`);
		}
		const actual = createHash(algorithm).update(body).digest("hex");
		if (actual !== expected) {
			throw new Error(
				`artifact checksum does not match source metadata: ${algorithm} expected=${expected} actual=${actual}`,
			);
		}
	}
	const content = inspectArtifactContent(candidate, fetched.response, body, fetched.finalUrl);
	const sha256 = createHash("sha256").update(body).digest("hex");
	const filename = candidate.id + "-" + safeDownloadName(fetched.finalUrl);
	const destination = join(root, "downloads", filename);
	await mkdir(dirname(destination), { recursive: true });
	if (await exists(destination)) {
		const existingSha256 = await sha256File(destination);
		if (existingSha256 !== sha256) {
			throw new Error(`existing destination SHA-256 mismatch: existing=${existingSha256} fetched=${sha256}`);
		}
		return {
			candidateId: candidate.id,
			sourceUrl: candidate.url,
			status: "skipped",
			localPath: destination,
			retrievedAt: new Date().toISOString(),
			finalUrl: fetched.finalUrl.href,
			sha256,
			bytes: body.length,
			...content,
			metadata,
			metadataFile,
			metadataError,
			failureReason: "destination already exists",
		};
	}
	const temporary = destination + "." + randomUUID() + ".tmp";
	try {
		await writeFile(temporary, body, { flag: "wx" });
		await rename(temporary, destination);
	} catch (error) {
		try {
			await unlink(temporary);
		} catch {
			// Best-effort cleanup of a bounded partial file.
		}
		throw error;
	}
	return {
		candidateId: candidate.id,
		sourceUrl: candidate.url,
		status: "downloaded",
		localPath: destination,
		retrievedAt: new Date().toISOString(),
		finalUrl: fetched.finalUrl.href,
		sha256,
		bytes: body.length,
		...content,
		metadata,
		metadataFile,
		metadataError,
	};
}

function isMetadataLandingPage(candidate: ArtifactCandidate, metadata: ArtifactSourceMetadata): boolean {
	const source = new URL(candidate.url);
	const parts = source.pathname.split("/").filter(Boolean);
	if (metadata.provider === "zenodo") {
		const marker = parts.findIndex((part) => part === "record" || part === "records");
		return marker >= 0 && parts.length === marker + 2;
	}
	return (
		metadata.provider === "figshare" &&
		(source.hostname === "figshare.com" || source.hostname.endsWith(".figshare.com"))
	);
}

function metadataFileCandidate(parent: ArtifactCandidate, file: ArtifactSourceFile): ArtifactCandidate {
	const url = new URL(file.url);
	return {
		id: `${parent.id}-file-${createHash("sha256").update(url.href).digest("hex").slice(0, 12)}`,
		url: url.href,
		kind: parent.kind,
		host: url.hostname.toLowerCase(),
		parentCandidateId: parent.id,
		sources: parent.sources,
		confidence: "high",
	};
}

async function resolveDoiCandidate(
	candidate: ArtifactCandidate,
	network: ArtifactNetworkOptions,
): Promise<ArtifactCandidate> {
	const fetched = await fetchPublicUrl(new URL(candidate.url), {
		...network,
		init: { headers: { accept: "text/html,application/json,application/octet-stream" } },
	});
	if (!fetched.response.ok) throw new Error(`DOI resolution returned HTTP ${fetched.response.status}`);
	await fetched.response.body?.cancel();
	if (fetched.finalUrl.hostname.toLowerCase() === "doi.org") {
		throw new Error("DOI resolver did not return an external artifact location");
	}
	const host = fetched.finalUrl.hostname.toLowerCase();
	const kind = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"].includes(host)
		? "repository"
		: host.endsWith("zenodo.org") || host === "figshare.com" || host.endsWith(".figshare.com")
			? "dataset"
			: candidate.kind === "unknown"
				? "project"
				: candidate.kind;
	return {
		...candidate,
		url: fetched.finalUrl.href,
		host,
		kind,
	};
}

export async function acquireArtifacts(
	pi: CommandExecutor,
	manifest: ArtifactManifest,
	options: {
		candidateIds?: string[];
		maxArtifacts: number;
		maxBytesPerArtifact: number;
		signal?: AbortSignal;
		fetcher?: ArtifactNetworkOptions["fetcher"];
		resolver?: ArtifactNetworkOptions["resolver"];
		authorization: OperationExecutionAuthorization;
	},
): Promise<{ manifest: ArtifactManifest; manifestPath: string; root: string }> {
	if (!Number.isInteger(options.maxArtifacts) || options.maxArtifacts < 1) {
		throw new Error("maxArtifacts must be a positive integer");
	}
	const selected = selectArtifactCandidates(manifest, options.candidateIds);
	assertArtifactSelection(manifest, options.candidateIds, selected);
	await authorizeOperationExecution(
		options.authorization,
		artifactAcquisitionPlan(manifest, {
			candidateIds: options.candidateIds,
			maxArtifacts: options.maxArtifacts,
			maxBytesPerArtifact: options.maxBytesPerArtifact,
		}),
	);
	const root = acquisitionRoot(manifest);
	await mkdir(root, { recursive: true });
	const manifestPath = join(root, "artifact-manifest.json");
	const existingManifest = await readExistingManifest(manifestPath, manifest.pdfSha256);
	const acquisitions: ArtifactSnapshot[] = [];
	const candidates = [...manifest.candidates];
	for (const selectedCandidate of selected) {
		if (acquisitions.length >= options.maxArtifacts) break;
		let effectiveCandidate = selectedCandidate;
		let metadata: ArtifactSourceMetadata | undefined;
		let metadataError: string | undefined;
		try {
			if (selectedCandidate.host.toLowerCase() === "doi.org") {
				effectiveCandidate = await resolveDoiCandidate(selectedCandidate, {
					signal: options.signal,
					fetcher: options.fetcher,
					resolver: options.resolver,
				});
				if (!candidates.some((candidate) => candidate.id === effectiveCandidate.id)) {
					candidates.push(effectiveCandidate);
				}
			}
			metadata = await resolveArtifactSourceMetadata(effectiveCandidate, {
				signal: options.signal,
				fetcher: options.fetcher,
				resolver: options.resolver,
			});
		} catch (error) {
			metadataError = error instanceof Error ? error.message : String(error);
		}
		let acquisitionCandidates: Array<{ candidate: ArtifactCandidate; metadataFile?: ArtifactSourceFile }> = [
			{ candidate: effectiveCandidate },
		];
		if (metadata && isMetadataLandingPage(effectiveCandidate, metadata)) {
			acquisitionCandidates = (metadata.files ?? []).map((file) => ({
				candidate: metadataFileCandidate(effectiveCandidate, file),
				metadataFile: file,
			}));
			for (const item of acquisitionCandidates) {
				if (!candidates.some((candidate) => candidate.id === item.candidate.id)) candidates.push(item.candidate);
			}
			if (acquisitionCandidates.length === 0) {
				acquisitions.push({
					candidateId: selectedCandidate.id,
					sourceUrl: selectedCandidate.url,
					status: "failed",
					retrievedAt: new Date().toISOString(),
					metadata,
					failureReason: "artifact metadata record exposes no downloadable files",
				});
				continue;
			}
		}
		for (const { candidate, metadataFile } of acquisitionCandidates) {
			if (acquisitions.length >= options.maxArtifacts) break;
			try {
				const previous = existingManifest?.acquisitions
					.filter(
						(snapshot) =>
							snapshot.candidateId === candidate.id &&
							(snapshot.status === "downloaded" ||
								snapshot.status === "cloned" ||
								snapshot.status === "skipped"),
					)
					.at(-1);
				if (previous) {
					const validation = await validateExistingSnapshot(pi, previous, root, options.signal);
					if (validation.valid) {
						acquisitions.push({
							...previous,
							...validation.evidence,
							status: "skipped",
							retrievedAt: new Date().toISOString(),
							failureReason:
								"reused integrity-verified provenance snapshot without repeated network acquisition",
						});
						continue;
					}
					if (previous.localPath && (await exists(previous.localPath))) {
						acquisitions.push({
							candidateId: candidate.id,
							sourceUrl: candidate.url,
							status: "failed",
							localPath: previous.localPath,
							retrievedAt: new Date().toISOString(),
							failureReason: `refused to reuse existing snapshot: ${validation.reason ?? "integrity validation failed"}`,
						});
						continue;
					}
				}
				const snapshot =
					candidate.kind === "repository"
						? await cloneRepository(pi, candidate, root, metadata, metadataError, options.signal, {
								fetcher: options.fetcher,
								resolver: options.resolver,
							})
						: await downloadArtifact(
								candidate,
								root,
								options.maxBytesPerArtifact,
								metadata,
								metadataError,
								metadataFile,
								options.signal,
								{ fetcher: options.fetcher, resolver: options.resolver },
							);
				acquisitions.push(snapshot);
			} catch (error) {
				acquisitions.push({
					candidateId: candidate.id,
					sourceUrl: candidate.url,
					status: "failed",
					retrievedAt: new Date().toISOString(),
					failureReason: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	const updated: ArtifactManifest = {
		...manifest,
		candidates,
		acquisitions: [...(existingManifest?.acquisitions ?? manifest.acquisitions), ...acquisitions],
	};
	await atomicJson(manifestPath, updated);
	return { manifest: updated, manifestPath, root };
}

export function artifactAcquisitionPlan(
	manifest: ArtifactManifest,
	options: { candidateIds?: string[]; maxArtifacts: number; maxBytesPerArtifact: number },
): OperationPlan {
	const selected = selectArtifactCandidates(manifest, options.candidateIds);
	assertArtifactSelection(manifest, options.candidateIds, selected);
	return {
		kind: "artifact-acquisition",
		summary: `Acquire up to ${options.maxArtifacts} artifacts discovered in ${manifest.pdfPath}`,
		targets: selected.slice(0, options.maxArtifacts).map((candidate) => ({
			label: `${candidate.kind}:${candidate.id}`,
			value: candidate.url,
			risk: candidate.confidence === "low" ? "high" : "medium",
		})),
		details: {
			pdfPath: manifest.pdfPath,
			pdfSha256: manifest.pdfSha256,
			candidateIds: selected.map((candidate) => candidate.id).sort(),
			maxArtifacts: options.maxArtifacts,
			maxBytesPerArtifact: options.maxBytesPerArtifact,
			excludedLowConfidenceCount:
				options.candidateIds === undefined
					? manifest.candidates.filter(
							(candidate) => !candidate.parentCandidateId && candidate.confidence === "low",
						).length
					: 0,
		},
	};
}

export function selectArtifactCandidates(manifest: ArtifactManifest, candidateIds?: string[]): ArtifactCandidate[] {
	if (candidateIds !== undefined) {
		return manifest.candidates.filter((candidate) => candidateIds.includes(candidate.id));
	}
	return manifest.candidates.filter((candidate) => !candidate.parentCandidateId && candidate.confidence !== "low");
}

export function assertArtifactSelection(
	manifest: ArtifactManifest,
	candidateIds?: string[],
	selected = selectArtifactCandidates(manifest, candidateIds),
): void {
	if (manifest.candidates.length === 0 || selected.length > 0) return;
	if (candidateIds === undefined) {
		throw new Error(
			"Only low-confidence artifact candidates were discovered. Review the discovery evidence and pass the intended candidate_ids explicitly.",
		);
	}
	throw new Error("Select at least one discovered artifact candidate before acquisition");
}
