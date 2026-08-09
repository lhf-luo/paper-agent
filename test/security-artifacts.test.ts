import { describe, expect, it, vi } from "vitest";
import { extractArtifactCandidates } from "../src/artifact-discovery.ts";
import {
	assertPublicUrl,
	fetchPublicUrl,
	fetchWithRetry,
	isPrivateAddress,
	readResponseBody,
} from "../src/network-security.ts";

describe("network and artifact security", () => {
	it("rejects private and reserved addresses while accepting an exclusively public resolution", async () => {
		expect(isPrivateAddress("127.0.0.1")).toBe(true);
		expect(isPrivateAddress("10.0.0.5")).toBe(true);
		expect(isPrivateAddress("2001:db8::1")).toBe(true);
		expect(isPrivateAddress("8.8.8.8")).toBe(false);
		await expect(
			assertPublicUrl(new URL("https://example.test/source"), async () => [{ address: "93.184.216.34" }]),
		).resolves.toEqual(["93.184.216.34"]);
		await expect(assertPublicUrl(new URL("http://127.0.0.1/admin"))).rejects.toThrow(/Private or reserved/);
		await expect(assertPublicUrl(new URL("file:///tmp/source"))).rejects.toThrow(/Only http/);
		await expect(assertPublicUrl(new URL("https://user:secret@example.com/"))).rejects.toThrow(/credentials/);
	});

	it("revalidates redirect targets before making a second request", async () => {
		const fetcher = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
		);
		await expect(
			fetchPublicUrl(new URL("https://example.test/start"), {
				fetcher,
				resolver: async () => [{ address: "93.184.216.34" }],
			}),
		).rejects.toThrow(/Private or reserved/);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("rejects HTTPS downgrades before requesting the redirect target", async () => {
		const fetcher = vi.fn(async () => Response.redirect("http://downloads.example.test/artifact.tar.gz", 302));
		await expect(
			fetchPublicUrl(new URL("https://example.test/start"), {
				fetcher,
				resolver: async () => [{ address: "93.184.216.34" }],
				requireHttps: true,
			}),
		).rejects.toThrow(/must use HTTPS/);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("applies the configured retry budget to each public redirect hop", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(Response.redirect("https://example.test/final", 302))
			.mockResolvedValueOnce(new Response("still busy", { status: 503 }))
			.mockResolvedValueOnce(new Response("ok"));
		const fetched = await fetchPublicUrl(new URL("https://example.test/start"), {
			fetcher,
			resolver: async () => [{ address: "93.184.216.34" }],
			maxRetries: 1,
			baseDelayMs: 1,
		});
		expect(fetched.finalUrl.href).toBe("https://example.test/final");
		expect(fetched.response.status).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(4);
	});

	it("revalidates DNS before a transient response is retried", async () => {
		const fetcher = vi.fn(async () => new Response("busy", { status: 503 }));
		const resolver = vi
			.fn()
			.mockResolvedValueOnce([{ address: "93.184.216.34" }])
			.mockResolvedValueOnce([{ address: "127.0.0.1" }]);
		await expect(
			fetchPublicUrl(new URL("https://example.test/start"), {
				fetcher,
				resolver,
				maxRetries: 1,
				baseDelayMs: 1,
			}),
		).rejects.toThrow(/exclusively to public addresses/);
		expect(resolver).toHaveBeenCalledTimes(2);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("enforces streamed response limits", async () => {
		const response = new Response("0123456789", { headers: { "content-length": "10" } });
		await expect(readResponseBody(response, 5)).rejects.toThrow(/limit is 5/);
	});

	it("enforces response limits when Content-Length is absent", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("0123456789"));
				controller.close();
			},
		});
		await expect(readResponseBody(new Response(stream), 5)).rejects.toThrow(/5-byte limit/);
	});

	it("retries bounded transient HTTP failures and then returns the successful response", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0" } }))
			.mockResolvedValueOnce(Response.json({ ok: true }));
		const response = await fetchWithRetry(new URL("https://example.test/api"), {
			fetcher,
			maxRetries: 2,
			baseDelayMs: 1,
		});
		expect(response.status).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("extracts and classifies artifact links with page and context provenance", () => {
		const text = [
			"Our implementation is available at github.com/example/project.",
			"The dataset is archived at https://zenodo.org/records/12345).",
			"An ordinary news link is https://example.com/news and should be ignored.",
		].join(" ");
		const candidates = extractArtifactCandidates(text, "pdftotext", 7);

		expect(candidates.map((candidate) => candidate.kind).sort()).toEqual(["dataset", "repository"]);
		expect(candidates.every((candidate) => candidate.sources[0].page === 7)).toBe(true);
		expect(candidates.find((candidate) => candidate.kind === "repository")?.url).toBe(
			"https://github.com/example/project",
		);
		expect(candidates.some((candidate) => candidate.url.includes("example.com/news"))).toBe(false);
	});

	it("rejects GitHub navigation pages and collapses file or tree links to one repository", () => {
		const text = [
			"Our source code is publicly available at https://github.com/example/project/tree/v1.2.0.",
			"The license is at https://github.com/example/project/blob/main/LICENSE.",
			"Navigation: https://github.com/ https://github.com/search?q=fuzzing https://github.com/topics/fuzzing.",
		].join(" ");
		const candidates = extractArtifactCandidates(text, "pdftotext", 3);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			url: "https://github.com/example/project",
			kind: "repository",
			confidence: "high",
		});
		expect(candidates[0].sources.map((source) => source.url)).toEqual([
			"https://github.com/example/project/tree/v1.2.0",
			"https://github.com/example/project/blob/main/LICENSE",
		]);
	});

	it("uses author availability language rather than a known host alone to assign confidence", () => {
		const candidates = extractArtifactCandidates(
				[
					"Our implementation is available at https://github.com/example/ours.",
					"A related code repository is https://github.com/example/related.",
					"References: Example et al. https://github.com/example/citation.",
					"[12] Android source code vulnerability detection. [Online]. Available: http://arxiv.org/abs/2207.02988.",
					"Names are sampled from census data (https://namecensus.com/).",
				].join("\n"),
			"pdftotext",
			8,
		);

			expect(Object.fromEntries(candidates.map((candidate) => [candidate.url, candidate.confidence]))).toEqual({
				"https://github.com/example/citation": "low",
				"https://github.com/example/ours": "high",
				"https://github.com/example/related": "medium",
			});
			expect(candidates.some((candidate) => candidate.url.includes("arxiv.org"))).toBe(false);
			expect(candidates.some((candidate) => candidate.url.includes("namecensus.com"))).toBe(false);
	});
});
