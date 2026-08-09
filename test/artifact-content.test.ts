import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireArtifacts, artifactAcquisitionPlan } from "../src/artifact-acquisition.ts";
import { inspectArtifactContent, resolveArtifactSourceMetadata } from "../src/artifact-content.ts";
import type { ArtifactCandidate, ArtifactManifest } from "../src/literature-types.ts";
import { OperationConsentManager } from "../src/operation-consent.ts";

const temporaryPaths: string[] = [];
const publicResolver = async () => [{ address: "93.184.216.34" }];

type AcquisitionOptions = Omit<Parameters<typeof acquireArtifacts>[2], "authorization">;

async function acquireAuthorized(
	pi: Parameters<typeof acquireArtifacts>[0],
	manifest: ArtifactManifest,
	options: AcquisitionOptions,
) {
	const manager = new OperationConsentManager();
	const prepared = await manager.prepare(artifactAcquisitionPlan(manifest, options));
	const grant = await manager.confirm(prepared.operationId, prepared.manifestFingerprint, "test-user");
	return acquireArtifacts(pi, manifest, { ...options, authorization: { manager, grant } });
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function candidate(url: string, kind: ArtifactCandidate["kind"] = "supplement"): ArtifactCandidate {
	return {
		id: "artifact-content",
		url,
		kind,
		host: new URL(url).hostname,
		sources: [{ method: "pdftotext", page: 2, context: "artifact available here" }],
		confidence: "high",
	};
}

describe("artifact content and source metadata", () => {
	it("validates archive magic and rejects HTML masquerading as an artifact", () => {
		const zip = Buffer.from("504b030414000000", "hex");
		expect(
			inspectArtifactContent(
				candidate("https://example.org/data.zip"),
				new Response(zip, { headers: { "content-type": "application/zip" } }),
				zip,
			).detectedContentType,
		).toBe("application/zip");
		const html = Buffer.from("<!doctype html><html><body>login</body></html>");
		expect(() =>
			inspectArtifactContent(
				candidate("https://example.org/data.zip"),
				new Response(html, { headers: { "content-type": "text/html" } }),
				html,
			),
		).toThrow(/does not match \.zip|HTML landing page/);
		const legacyTar = Buffer.alloc(512, 1);
		expect(
			inspectArtifactContent(
				candidate("https://example.org/legacy.tar"),
				new Response(legacyTar, { headers: { "content-type": "application/x-tar" } }),
				legacyTar,
			),
		).toMatchObject({ detectedContentType: "text/plain", contentValidation: "unverified" });
	});

	it("normalizes Zenodo metadata without trusting it as downloaded content", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				doi: "10.5281/zenodo.12345",
				metadata: { version: "2.0", publication_date: "2026-01-01", license: { id: "mit" } },
				files: [
					{
						key: "artifact.zip",
						size: 42,
						checksum: "md5:abc",
						links: { content: "https://zenodo.org/api/records/12345/files/artifact.zip/content" },
					},
				],
			}),
		);
		const metadata = await resolveArtifactSourceMetadata(candidate("https://zenodo.org/records/12345", "dataset"), {
			fetcher,
			resolver: publicResolver,
		});
		expect(metadata).toMatchObject({
			provider: "zenodo",
			recordId: "12345",
			version: "2.0",
			doi: "10.5281/zenodo.12345",
			license: "mit",
		});
		expect(metadata?.files?.[0]).toMatchObject({ name: "artifact.zip", bytes: 42 });
	});

	it("stores validated download provenance and reuses it without a second request", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-content-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const zip = Buffer.from("504b030414000000", "hex");
		const fetcher = vi.fn(
			async () =>
				new Response(zip, {
					status: 200,
					headers: { "content-type": "application/zip", "content-length": String(zip.length) },
				}),
		);
		const manifest: ArtifactManifest = {
			schemaVersion: 1,
			pdfPath,
			pdfSha256: "f".repeat(64),
			discoveredAt: "2026-01-01T00:00:00.000Z",
			candidates: [candidate("https://example.org/artifact.zip")],
			acquisitions: [],
		};
		const options = {
			maxArtifacts: 10,
			maxBytesPerArtifact: 1024,
			fetcher,
			resolver: publicResolver,
		};
		const first = await acquireAuthorized({ exec: vi.fn() } as unknown as ExtensionAPI, manifest, options);
		expect(first.manifest.acquisitions.at(-1)).toMatchObject({
			status: "downloaded",
			contentType: "application/zip",
			detectedContentType: "application/zip",
			contentValidation: "validated",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);

		const second = await acquireAuthorized({ exec: vi.fn() } as unknown as ExtensionAPI, manifest, options);
		expect(second.manifest.acquisitions.at(-1)?.status).toBe("skipped");
		expect(fetcher).toHaveBeenCalledTimes(1);
		const localPath = second.manifest.acquisitions.at(-1)?.localPath;
		if (!localPath) throw new Error("download path missing");
		expect(await readFile(localPath)).toEqual(zip);
	});

	it("expands a Zenodo record into bounded, checksum-verified file acquisitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-zenodo-record-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const zip = Buffer.from("504b030414000000", "hex");
		const checksum = createHash("md5").update(zip).digest("hex");
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/records/12345") {
				return Response.json({
					metadata: { license: { id: "mit" } },
					files: [
						{
							key: "artifact.zip",
							size: zip.length,
							checksum: `md5:${checksum}`,
							links: { content: "https://zenodo.org/api/records/12345/files/artifact.zip/content" },
						},
					],
				});
			}
			return new Response(zip, { headers: { "content-type": "application/zip" } });
		});
		const result = await acquireAuthorized(
			{ exec: vi.fn() } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "b".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [candidate("https://zenodo.org/records/12345", "dataset")],
				acquisitions: [],
			},
			{ maxArtifacts: 2, maxBytesPerArtifact: 1024, fetcher, resolver: publicResolver },
		);

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(result.manifest.candidates).toHaveLength(2);
		expect(result.manifest.candidates[1]).toMatchObject({
			parentCandidateId: "artifact-content",
			url: "https://zenodo.org/api/records/12345/files/artifact.zip/content",
		});
		expect(result.manifest.acquisitions).toHaveLength(1);
		expect(result.manifest.acquisitions[0]).toMatchObject({
			status: "downloaded",
			metadataFile: { name: "artifact.zip", checksum: `md5:${checksum}` },
			metadata: { provider: "zenodo", recordId: "12345" },
		});
	});

	it("resolves a DOI candidate before acquiring its public artifact target", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-doi-artifact-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const zip = Buffer.from("504b030414000000", "hex");
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.hostname === "doi.org") {
				return new Response(null, {
					status: 302,
					headers: { location: "https://example.org/artifact.zip" },
				});
			}
			return new Response(zip, { headers: { "content-type": "application/zip" } });
		});
		const result = await acquireAuthorized(
			{ exec: vi.fn() } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "c".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [candidate("https://doi.org/10.5281/zenodo.12345", "unknown")],
				acquisitions: [],
			},
			{ maxArtifacts: 1, maxBytesPerArtifact: 1024, fetcher, resolver: publicResolver },
		);

		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(result.manifest.acquisitions[0]).toMatchObject({
			status: "downloaded",
			finalUrl: "https://example.org/artifact.zip",
			detectedContentType: "application/zip",
		});
	});

	it("resolves and records a Git ref before publishing a clone", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-git-ref-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const repository = candidate("https://github.com/example/repo/releases/tag/v1.2.3", "repository");
		const fetcher = vi.fn(async () => Response.json({ default_branch: "main", license: { spdx_id: "MIT" } }));
		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args.includes("clone")) {
				const path = args.at(-1);
				if (!path) throw new Error("clone path missing");
				await mkdir(path, { recursive: true });
				await mkdir(join(path, ".git"), { recursive: true });
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (args.includes("fetch") || args.includes("checkout")) {
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			const joined = args.join(" ");
			if (joined.includes("rev-parse HEAD"))
				return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "", killed: false };
			if (joined.includes("remote get-url origin"))
				return { code: 0, stdout: "https://github.com/example/repo.git\n", stderr: "", killed: false };
			if (joined.includes("branch --show-current")) return { code: 0, stdout: "\n", stderr: "", killed: false };
			if (joined.includes("describe --tags")) return { code: 0, stdout: "v1.2.3\n", stderr: "", killed: false };
			if (joined.includes("--is-shallow-repository"))
				return { code: 0, stdout: "true\n", stderr: "", killed: false };
			return { code: 1, stdout: "", stderr: "unsupported fake git call", killed: false };
		});
		const result = await acquireAuthorized(
			{ exec } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "e".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [repository],
				acquisitions: [],
			},
			{
				maxArtifacts: 1,
				maxBytesPerArtifact: 1024,
				fetcher,
				resolver: publicResolver,
			},
		);
		expect(result.manifest.acquisitions.at(-1)).toMatchObject({
			status: "cloned",
			requestedRef: "v1.2.3",
			tag: "v1.2.3",
			shallow: true,
			metadata: { provider: "github", license: "MIT", resolvedCommit: "a".repeat(40) },
		});
		expect(exec.mock.calls.some(([, args]) => args.includes("fetch") && args.includes("v1.2.3"))).toBe(true);
		expect(exec.mock.calls.some(([, args]) => args.includes("http.followRedirects=false"))).toBe(true);
		expect(exec.mock.calls.some(([, args]) => args.includes("http.sslVerify=true"))).toBe(true);
		expect(exec.mock.calls.some(([, args]) => args.some((arg) => arg.startsWith("http.curloptResolve=")))).toBe(true);
	});

	it("tries progressively shorter tree refs without treating a subdirectory as the branch", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-git-tree-ref-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const repository = candidate("https://github.com/example/repo/tree/main/examples/demo", "repository");
		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args.includes("clone")) {
				const path = args.at(-1);
				if (!path) throw new Error("clone path missing");
				await mkdir(join(path, ".git"), { recursive: true });
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (args.includes("fetch")) {
				return args.at(-1) === "main"
					? { code: 0, stdout: "", stderr: "", killed: false }
					: { code: 1, stdout: "", stderr: "unknown ref", killed: false };
			}
			if (args.includes("checkout")) return { code: 0, stdout: "", stderr: "", killed: false };
			const joined = args.join(" ");
			if (joined.includes("rev-parse HEAD"))
				return { code: 0, stdout: `${"d".repeat(40)}\n`, stderr: "", killed: false };
			if (joined.includes("remote get-url origin"))
				return { code: 0, stdout: "https://github.com/example/repo.git\n", stderr: "", killed: false };
			if (joined.includes("branch --show-current")) return { code: 0, stdout: "\n", stderr: "", killed: false };
			if (joined.includes("describe --tags")) return { code: 1, stdout: "", stderr: "", killed: false };
			if (joined.includes("--is-shallow-repository"))
				return { code: 0, stdout: "true\n", stderr: "", killed: false };
			return { code: 1, stdout: "", stderr: "unsupported fake git call", killed: false };
		});
		const result = await acquireAuthorized(
			{ exec } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "d".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [repository],
				acquisitions: [],
			},
			{
				maxArtifacts: 1,
				maxBytesPerArtifact: 1024,
				fetcher: async () => Response.json({ default_branch: "main" }),
				resolver: publicResolver,
			},
		);
		expect(result.manifest.acquisitions.at(-1)).toMatchObject({ status: "cloned", requestedRef: "main" });
		const refs = exec.mock.calls.filter(([, args]) => args.includes("fetch")).map(([, args]) => args.at(-1));
		expect(refs).toEqual(["main/examples/demo", "main/examples", "main"]);
	});

	it("rejects unsafe Git refs and records verified addresses when checkout fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-git-ref-safety-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const unsafe = await acquireAuthorized(
			{ exec: vi.fn() } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "f".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [candidate("https://github.com/example/repo/tree/bad%20ref", "repository")],
				acquisitions: [],
			},
			{
				maxArtifacts: 1,
				maxBytesPerArtifact: 1024,
				fetcher: async () => Response.json({ default_branch: "main" }),
				resolver: publicResolver,
			},
		);
		expect(unsafe.manifest.acquisitions[0]).toMatchObject({ status: "failed" });
		expect(unsafe.manifest.acquisitions[0].failureReason).toContain("unsafe or malformed");

		const exec = vi.fn(async (_command: string, args: string[]) => {
			if (args.includes("clone")) {
				const path = args.at(-1);
				if (path) await mkdir(join(path, ".git"), { recursive: true });
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (args.includes("fetch")) return { code: 0, stdout: "", stderr: "", killed: false };
			if (args.includes("checkout")) return { code: 1, stdout: "", stderr: "checkout failed", killed: false };
			return { code: 1, stdout: "", stderr: "unexpected", killed: false };
		});
		const failedCheckout = await acquireAuthorized(
			{ exec } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "f".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [candidate("https://github.com/example/repo/tree/main", "repository")],
				acquisitions: [],
			},
			{
				maxArtifacts: 1,
				maxBytesPerArtifact: 1024,
				fetcher: async () => Response.json({ default_branch: "main" }),
				resolver: publicResolver,
			},
		);
		expect(failedCheckout.manifest.acquisitions.at(-1)).toMatchObject({
			status: "failed",
			resolvedAddresses: ["93.184.216.34"],
			failureReason: "checkout failed",
		});
	});

	it("rejects insecure artifact downloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-http-artifact-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const result = await acquireAuthorized(
			{ exec: vi.fn() } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "f".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [candidate("http://example.org/data.zip")],
				acquisitions: [],
			},
			{ maxArtifacts: 1, maxBytesPerArtifact: 1024, resolver: publicResolver },
		);
		expect(result.manifest.acquisitions[0]).toMatchObject({ status: "failed" });
		expect(result.manifest.acquisitions[0].failureReason).toContain("must use public HTTPS");
	});

	it("rejects a declared checksum that cannot be verified", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-checksum-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const zip = Buffer.from("504b030414000000", "hex");
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			return url.pathname === "/api/records/99"
				? Response.json({
						files: [
							{
								key: "artifact.zip",
								checksum: "crc32:12345678",
								links: { content: "https://zenodo.org/api/records/99/files/artifact.zip/content" },
							},
						],
					})
				: new Response(zip, { headers: { "content-type": "application/zip" } });
		});
		const result = await acquireAuthorized(
			{ exec: vi.fn() } as unknown as ExtensionAPI,
			{
				schemaVersion: 1,
				pdfPath,
				pdfSha256: "e".repeat(64),
				discoveredAt: "2026-01-01T00:00:00.000Z",
				candidates: [candidate("https://zenodo.org/records/99", "dataset")],
				acquisitions: [],
			},
			{ maxArtifacts: 1, maxBytesPerArtifact: 1024, fetcher, resolver: publicResolver },
		);
		expect(result.manifest.acquisitions[0]).toMatchObject({ status: "failed" });
		expect(result.manifest.acquisitions[0].failureReason).toContain("unsupported or malformed checksum");
	});
});
