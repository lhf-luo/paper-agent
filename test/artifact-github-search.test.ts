import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectArtifactCandidates } from "../src/artifacts/application/artifact-acquisition.ts";
import { externalArtifactCandidates } from "../src/artifacts/application/artifact-external-candidates.ts";
import {
	buildGitHubArtifactQueries,
	searchGitHubArtifacts,
} from "../src/artifacts/application/artifact-github-search.ts";
import { inferArtifactPaperIdentity } from "../src/artifacts/application/artifact-paper-identity.ts";
import { discoverPaperArtifacts } from "../src/artifacts/application/paper-artifact-discovery.ts";

const temporaryPaths: string[] = [];
const publicResolver = async () => [{ address: "93.184.216.34" }];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function githubFetcher(readme: string, requests: Array<{ url: URL; authorization?: string }>) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const headers = new Headers(init?.headers);
		requests.push({ url, authorization: headers.get("authorization") ?? undefined });
		if (url.pathname === "/search/repositories") {
			return Response.json({
				items: [
					{
						full_name: "evanmak/savior-source",
						name: "savior-source",
						html_url: "https://github.com/evanmak/savior-source",
						description: "Source release for SAVIOR",
						private: false,
						size: 145_760,
					},
				],
			});
		}
		return Response.json({ content: Buffer.from(readme).toString("base64"), encoding: "base64" });
	});
}

describe("GitHub artifact fallback", () => {
	it("builds at most three bounded repository queries", () => {
		const queries = buildGitHubArtifactQueries({
			title: "SAVIOR: Towards Bug-Driven Hybrid Testing",
			doi: "10.1109/SP40000.2020.00002",
		});
		expect(queries).toHaveLength(3);
		expect(queries[0]).toBe('"savior" in:name,description,readme');
		expect(queries[1]).toContain("10.1109/sp40000.2020.00002");
	});

	it("extracts implementation names and searches them before DOI or paper title", () => {
		const identity = inferArtifactPaperIdentity(
			"",
			[
				"Session 8D: Language Security CCS '19, London",
				"Where Does It Go?: Refining Indirect-Call Targets with Multi-Layer Type Analysis",
				"We propose a new approach, namely Multi-Layer Type Analysis (MLTA).",
				"We implemented it in a system, namely TypeDive, based on LLVM.",
				"https://doi.org/10.1145/3319535.3354244",
			].join("\n"),
		);
		expect(identity).toMatchObject({
			title: "Where Does It Go?: Refining Indirect-Call Targets with Multi-Layer Type Analysis",
			doi: "10.1145/3319535.3354244",
			projectNames: ["TypeDive", "MLTA"],
		});
		expect(buildGitHubArtifactQueries(identity ?? {})).toEqual([
			'"typedive" in:name,description,readme',
			'"mlta" in:name,description,readme',
			'"10.1145/3319535.3354244" in:readme',
		]);
	});

	it("uses stored paper metadata while keeping PDF-extracted project names", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-project-name-fallback-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const requests: URL[] = [];
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			requests.push(url);
			return Response.json({ items: [] });
		});
		const exec = vi.fn(async (command: string) => ({
			code: 0,
			stdout:
				command === "pdfinfo"
					? ""
					: [
							"Session 8D: Language Security CCS '19, London",
							"Where Does It Go?: Refining Indirect-Call Targets with Multi-Layer Type Analysis",
							"We implemented it in a system, namely TypeDive, based on LLVM.",
							"We propose Multi-Layer Type Analysis (MLTA).",
						].join("\n"),
			stderr: "",
			killed: false,
		}));
		const manifest = await discoverPaperArtifacts({ exec }, pdfPath, {
			paper: {
				title: "Where Does It Go?: Refining Indirect-Call Targets with Multi-Layer Type Analysis",
				authors: ["Junjie Wang", "Chen Zhang"],
				identifiers: { doi: "10.1145/3319535.3354244" },
			},
			fetcher,
			resolver: publicResolver,
		});
		expect(manifest.paperIdentity).toMatchObject({
			title: "Where Does It Go?: Refining Indirect-Call Targets with Multi-Layer Type Analysis",
			doi: "10.1145/3319535.3354244",
			projectNames: ["TypeDive", "MLTA"],
		});
		expect(requests.map((url) => url.searchParams.get("q"))).toEqual([
			'"typedive" in:name,description,readme',
			'"mlta" in:name,description,readme',
			'"10.1145/3319535.3354244" in:readme',
		]);
	});

	it("finds SAVIOR from GitHub API and README evidence when PDF links are citation-only", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-github-fallback-"));
		temporaryPaths.push(root);
		const pdfPath = join(root, "paper.pdf");
		await writeFile(pdfPath, "%PDF-fixture");
		const requests: Array<{ url: URL; authorization?: string }> = [];
		const fetcher = githubFetcher(
			"# SAVIOR\nSAVIOR: Towards Bug-Driven Hybrid Testing. This repository contains the source artifact.",
			requests,
		);
		const exec = vi.fn(async (command: string) => ({
			code: 0,
			stdout:
				command === "pdfinfo"
					? ""
					: "References\nBaseline code [Online]. Available: https://github.com/example/baseline\f",
			stderr: "",
			killed: false,
		}));
		const manifest = await discoverPaperArtifacts({ exec }, pdfPath, {
			paper: {
				title: "SAVIOR: Towards Bug-Driven Hybrid Testing",
				authors: ["Yaohui Chen", "Peng Li"],
				identifiers: {},
			},
			githubToken: "configured-token",
			fetcher,
			resolver: publicResolver,
		});
		const savior = manifest.candidates.find((candidate) => candidate.url.endsWith("evanmak/savior-source"));
		expect(savior).toMatchObject({
			confidence: "high",
			relationship: "artifact-context",
			estimatedBytes: 145_760 * 1024,
		});
		expect(savior?.sources.every((source) => source.method === "github-search")).toBe(true);
		expect(savior?.signals).toContain("exact-title-match");
		expect(selectArtifactCandidates(manifest).map((candidate) => candidate.id)).toContain(savior?.id);
		expect(requests.every((request) => request.url.hostname === "api.github.com")).toBe(true);
		expect(requests.every((request) => request.authorization === "Bearer configured-token")).toBe(true);
	});

	it("does not default-select a medium-confidence GitHub result", async () => {
		const requests: Array<{ url: URL; authorization?: string }> = [];
		const result = await searchGitHubArtifacts(
			{ title: "SAVIOR: Towards Bug-Driven Hybrid Testing", authors: ["Evan Mak"] },
			{
				fetcher: githubFetcher("# SAVIOR\nHybrid testing implementation by Evan Mak.", requests),
				resolver: publicResolver,
			},
		);
		expect(result.candidates[0]?.confidence).toBe("medium");
		expect(
			selectArtifactCandidates({
				schemaVersion: 1,
				pdfPath: "paper.pdf",
				pdfSha256: "a".repeat(64),
				discoveredAt: new Date().toISOString(),
				candidates: result.candidates,
				acquisitions: [],
			}),
		).toEqual([]);
	});

	it("turns GitHub rate limits into non-blocking discovery warnings", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("rate limited", {
					status: 403,
					headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 60) },
				}),
		);
		const result = await searchGitHubArtifacts(
			{ title: "SAVIOR: Towards Bug-Driven Hybrid Testing" },
			{ fetcher, resolver: publicResolver },
		);
		expect(result.candidates).toEqual([]);
		expect(result.warnings).toHaveLength(3);
		expect(result.warnings.every((warning) => warning.code === "rate-limited")).toBe(true);
	});
});

describe("explicit artifact URLs", () => {
	it("accepts supported HTTPS sites and rejects unsafe or unknown URLs", () => {
		const result = externalArtifactCandidates([
			"https://github.com/evanmak/savior-source",
			"http://github.com/evanmak/savior-source",
			"https://example.com/download.zip",
			"https://token@example.com/private",
		]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			confidence: "medium",
			sources: [{ method: "external-url" }],
		});
		expect(result.warnings).toHaveLength(3);
	});
});
