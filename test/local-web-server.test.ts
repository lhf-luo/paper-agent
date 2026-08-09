import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/app-config.ts";
import type { CommandExecutor } from "../src/command-executor.ts";
import type { PaperRecord } from "../src/literature-types.ts";
import { startLocalWebServer } from "../src/local-web-server.ts";
import { PaperAgentApplication } from "../src/paper-agent-application.ts";
import { createTeamCorpusServer, hashTeamToken } from "../src/team-corpus-server.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createArtifactReviewFixture(root: string) {
	const artifactRoot = join(root, "eval-data", "artifacts");
	const pdfRoot = join(root, "eval-data", "pdfs");
	await mkdir(join(artifactRoot, "candidates"), { recursive: true });
	await mkdir(join(artifactRoot, "annotations"), { recursive: true });
	await mkdir(pdfRoot, { recursive: true });
	const pdf = Buffer.from("%PDF-1.4\nweb review fixture\n%%EOF\n");
	const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
	await writeFile(join(pdfRoot, "web-review.pdf"), pdf);
	await writeFile(
		join(artifactRoot, "sources.json"),
		JSON.stringify([
			{
				slug: "web-review",
				title: "Web Artifact Review",
				paperId: "arxiv:0000.00001",
				pdfPath: "../pdfs/web-review.pdf",
				pdfSha256,
				sourceUrl: "https://arxiv.org/pdf/0000.00001",
				status: "available",
				tags: ["web-fixture"],
			},
		]),
	);
	await writeFile(
		join(artifactRoot, "candidates", "web-review.json"),
		JSON.stringify({
			schemaVersion: 1,
			annotationStatus: "machine-generated-candidate",
			source: {
				slug: "web-review",
				title: "Web Artifact Review",
				paperId: "arxiv:0000.00001",
				pdfPath: "../../pdfs/web-review.pdf",
				pdfSha256,
				sourceUrl: "https://arxiv.org/pdf/0000.00001",
			},
			inspection: { allPagesReviewed: false },
			expectedArtifacts: [],
			ignoredUrls: [],
			detectorCandidates: [
				{
					id: "candidate-web-repository",
					url: "https://github.com/example/web-review",
					kind: "repository",
					host: "github.com",
					confidence: "high",
					sources: [{ method: "pdftotext", page: 2, context: "The implementation is available online." }],
				},
			],
		}),
	);
	return { artifactRoot, pdf, pdfSha256 };
}

describe("local Paper Agent web server", () => {
	it("serves the UI publicly on loopback while protecting every API route with a session token", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "web");
		await mkdir(join(staticRoot, "assets"), { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Paper Agent</title>");
		await writeFile(join(staticRoot, "assets", "worker.mjs"), "export default 'worker';");
		const artifactFixture = await createArtifactReviewFixture(root);
		const executor: CommandExecutor = {
			exec: async () => ({ stdout: "Pages:          2\n", stderr: "", code: 0, killed: false }),
		};
		const application = new PaperAgentApplication({
			projectRoot: root,
			dataRoot: join(root, ".paper-agent"),
			executor,
		});
		const record: PaperRecord = {
			id: "paper-web",
			title: "Stateful fuzzing",
			authors: ["Researcher"],
			identifiers: {},
			links: [{ url: "https://example.org/paper", kind: "landing" }],
			provenance: [{ provider: "json-import", query: "fixture", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		};
		await application.personalStore().upsertPaper(record);
		const token = "test-session-token";
		const server = await startLocalWebServer(application, { staticRoot, sessionToken: token });
		try {
			const page = await fetch(server.url);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("Paper Agent");
			const workerModule = await fetch(`${server.url}/assets/worker.mjs`);
			expect(workerModule.status).toBe(200);
			expect(workerModule.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

				const unauthorized = await fetch(`${server.url}/api/status`);
				expect(unauthorized.status).toBe(401);
				const unauthorizedAgent = await fetch(`${server.url}/api/agent/config`);
				expect(unauthorizedAgent.status).toBe(401);

			const library = await fetch(`${server.url}/api/library?q=stateful`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(library.status).toBe(200);
			expect((await library.json()) as unknown).toMatchObject({ hits: [{ record: { id: "paper-web" } }] });

			const authenticated = (path: string, init: RequestInit = {}) =>
				fetch(`${server.url}${path}`, {
					...init,
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
				});
			const evaluationQueue = await authenticated("/api/evaluation/artifacts");
			expect(evaluationQueue.status).toBe(200);
			expect(await evaluationQueue.json()).toMatchObject({
				totals: { papers: 1, humanReviewed: 0, pending: 1, candidates: 1 },
				papers: [{ slug: "web-review", humanReviewed: false }],
			});
			const evaluationDetail = await authenticated("/api/evaluation/artifacts/web-review");
			expect(evaluationDetail.status).toBe(200);
			expect(await evaluationDetail.json()).toMatchObject({
				pageCount: 2,
				pdfSha256: artifactFixture.pdfSha256,
				candidates: [{ id: "candidate-web-repository" }],
			});
			const evaluationPdf = await authenticated("/api/evaluation/artifacts/web-review/pdf");
			expect(evaluationPdf.status).toBe(200);
			expect(evaluationPdf.headers.get("content-type")).toBe("application/pdf");
			expect(Buffer.from(await evaluationPdf.arrayBuffer())).toEqual(artifactFixture.pdf);
			expect((await authenticated("/api/evaluation/artifacts/missing-paper")).status).toBe(404);
			const artifactSubmission = {
				reviewer: "human-web-reviewer",
				reviewedAt: "2026-08-07T09:00:00.000Z",
				reviewedPages: [1, 2],
				notes: "Every physical page was inspected in the authenticated web review flow.",
				candidateReviews: [
					{
						candidateId: "candidate-web-repository",
						disposition: "expected",
						artifactId: "official-web-code",
						kind: "repository",
						acceptedUrls: ["https://github.com/example/web-review.git"],
						pages: [2],
					},
				],
				manualArtifacts: [],
			};
			const artifactPrepare = await authenticated("/api/evaluation/artifacts/web-review/prepare", {
				method: "POST",
				body: JSON.stringify({ submission: artifactSubmission }),
			});
			expect(artifactPrepare.status).toBe(200);
			const artifactPlan = (await artifactPrepare.json()) as {
				operationId: string;
				manifestFingerprint: string;
				kind: string;
			};
			expect(artifactPlan.kind).toBe("artifact-evaluation-write");
			const artifactGrantResponse = await authenticated("/api/operations/confirm", {
				method: "POST",
				body: JSON.stringify(artifactPlan),
			});
			expect(artifactGrantResponse.status).toBe(200);
			const artifactGrant = await artifactGrantResponse.json();
			const artifactExecute = await authenticated("/api/evaluation/artifacts/web-review/execute", {
				method: "POST",
				body: JSON.stringify({ submission: artifactSubmission, grant: artifactGrant }),
			});
			expect(artifactExecute.status).toBe(200);
			expect(await artifactExecute.json()).toMatchObject({
				annotation: {
					annotationStatus: "human-reviewed",
					inspection: { reviewer: "human-web-reviewer", reviewedPages: [1, 2] },
					expectedArtifacts: [{ id: "official-web-code", pages: [2] }],
				},
			});
			const savedGold = JSON.parse(
				await readFile(join(artifactFixture.artifactRoot, "annotations", "web-review.json"), "utf8"),
			);
			expect(savedGold.annotationStatus).toBe("human-reviewed");
			const annotationPrepare = await authenticated("/api/library/annotations/prepare", {
				method: "POST",
				body: JSON.stringify({
					paperIds: ["paper-web"],
					tags: ["web-tested"],
					note: "Keep the evidence boundary visible.",
					screeningStatus: "include",
					screeningReason: "Fixture is relevant",
				}),
			});
			expect(annotationPrepare.status).toBe(200);
			const annotationPlan = (await annotationPrepare.json()) as {
				operationId: string;
				manifestFingerprint: string;
			};
			const annotationGrantResponse = await authenticated("/api/operations/confirm", {
				method: "POST",
				body: JSON.stringify(annotationPlan),
			});
			const annotationGrant = await annotationGrantResponse.json();
			const annotationExecute = await authenticated("/api/library/annotations/execute", {
				method: "POST",
				body: JSON.stringify({
					paperIds: ["paper-web"],
					tags: ["web-tested"],
					note: "Keep the evidence boundary visible.",
					screeningStatus: "include",
					screeningReason: "Fixture is relevant",
					grant: annotationGrant,
				}),
			});
			expect(annotationExecute.status).toBe(200);
			expect(await annotationExecute.json()).toMatchObject({ count: 1 });
			const annotatedDetails = await authenticated("/api/papers/paper-web?namespace=default");
			expect(await annotatedDetails.json()).toMatchObject({
				paper: {
					curation: {
						tags: ["web-tested"],
						screening: { status: "include" },
					},
				},
			});
			const exportPrepare = await authenticated("/api/library/export/prepare", {
				method: "POST",
				body: JSON.stringify({ format: "json", filename: "web-library.json", paperIds: ["paper-web"] }),
			});
			const exportPlan = (await exportPrepare.json()) as {
				operationId: string;
				manifestFingerprint: string;
			};
			const exportGrantResponse = await authenticated("/api/operations/confirm", {
				method: "POST",
				body: JSON.stringify(exportPlan),
			});
			const exportGrant = await exportGrantResponse.json();
			const exportExecute = await authenticated("/api/library/export/execute", {
				method: "POST",
				body: JSON.stringify({
					format: "json",
					filename: "web-library.json",
					paperIds: ["paper-web"],
					grant: exportGrant,
				}),
			});
			expect(exportExecute.status).toBe(200);
			const exported = await authenticated("/api/library/exports/web-library.json?namespace=default");
			expect(exported.status).toBe(200);
			expect(JSON.parse(await exported.text())).toMatchObject({ records: [{ id: "paper-web" }] });
			expect((await authenticated("/api/config")).status).toBe(200);
			const providers = await authenticated("/api/providers");
			expect(providers.status).toBe(200);
			expect((await providers.json()) as unknown).toMatchObject({
				providers: expect.arrayContaining([expect.objectContaining({ id: "arxiv" })]),
			});
			const namespaces = await authenticated("/api/namespaces");
			expect(namespaces.status).toBe(200);
			expect(await namespaces.json()).toMatchObject({ defaultNamespace: "default", personal: ["default"] });
			const malformedSearch = await authenticated("/api/search", {
				method: "POST",
				body: JSON.stringify({
					query: "stateful fuzzing",
					providers: ["arxiv"],
					filters: { authors: "not-an-array" },
				}),
			});
			expect(malformedSearch.status).toBe(400);
			expect(await malformedSearch.json()).toMatchObject({ error: expect.stringContaining("filters.authors") });
			const team = await authenticated("/api/team/overview");
			expect(await team.json()).toMatchObject({ configured: false, connected: false });

			const writeJob = await application.jobs.enqueue("pdf-download", {
				authorizationKey: "missing-confirmation",
				namespace: "default",
				request: { maxFiles: 1, maxBytesPerFile: 1, concurrency: 1 },
			});
			for (let attempt = 0; attempt < 100 && application.jobs.get(writeJob.id)?.status !== "failed"; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(application.jobs.get(writeJob.id)?.status).toBe("failed");
			const rejectedRetry = await authenticated(`/api/jobs/${encodeURIComponent(writeJob.id)}/retry`, {
				method: "POST",
				body: "{}",
			});
			expect(rejectedRetry.status).toBe(409);
			expect(await rejectedRetry.json()).toMatchObject({
				error: expect.stringContaining("new review and confirmation"),
			});

			const now = new Date().toISOString();
			const researchRecord = {
				id: "skim-web",
				kind: "skim-card",
				title: "Web research record",
				authorship: { type: "human", author: "tester", humanReviewed: true },
				createdAt: now,
				updatedAt: now,
				revision: 0,
				paperId: "paper-web",
				researchQuestion: "What is tested?",
				problem: "Stateful behavior",
				method: "Fixture",
				datasets: "Fixture",
				findings: "Traceable",
				limitations: "Synthetic",
				unknowns: "None",
				sources: [{ paperId: "paper-web", page: 1, quote: "Stateful fuzzing" }],
			};
			const preparedResponse = await authenticated("/api/research/write/prepare", {
				method: "POST",
				body: JSON.stringify({ record: researchRecord }),
			});
			expect(preparedResponse.status).toBe(200);
			const prepared = (await preparedResponse.json()) as { operationId: string; manifestFingerprint: string };
			const grantResponse = await authenticated("/api/operations/confirm", {
				method: "POST",
				body: JSON.stringify(prepared),
			});
			expect(grantResponse.status).toBe(200);
			const grant = await grantResponse.json();
			const saved = await authenticated("/api/research/write/execute", {
				method: "POST",
				body: JSON.stringify({ record: researchRecord, grant }),
			});
			expect(saved.status).toBe(200);
			expect(await saved.json()).toMatchObject({ id: "skim-web", revision: 1 });
			expect(await (await authenticated("/api/research")).json()).toMatchObject({ records: [{ id: "skim-web" }] });
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("refuses non-loopback listeners", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-host-"));
		temporaryPaths.push(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, ".paper-agent") });
		await expect(
			startLocalWebServer(application, { host: "0.0.0.0", staticRoot: root, sessionToken: "token" }),
		).rejects.toThrow("loopback");
		await application.close();
	});

	it("forwards team search filters and cursor pagination through the authenticated local API", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-web-team-search-"));
		temporaryPaths.push(root);
		const staticRoot = join(root, "web");
		await mkdir(staticRoot, { recursive: true });
		await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Paper Agent</title>");
		const teamServer = createTeamCorpusServer({
			root: join(root, "team"),
			identities: [{ name: "admin", tokenSha256: hashTeamToken("team-search-token"), roles: ["admin"] }],
		});
		await new Promise<void>((resolve) => teamServer.listen(0, "127.0.0.1", resolve));
		const address = teamServer.address();
		if (!address || typeof address === "string") throw new Error("team server did not bind a TCP port");
		const teamUrl = `http://127.0.0.1:${address.port}`;
		const envName = "PAPER_AGENT_LOCAL_WEB_TEAM_SEARCH_TOKEN";
		const originalToken = process.env[envName];
		process.env[envName] = "team-search-token";
		await savePaperAgentConfig(root, {
			...defaultPaperAgentConfig(),
			team: { serverUrl: teamUrl, namespace: "security", tokenEnvironmentVariable: envName },
		});
		const record = (id: string, year: number): PaperRecord => ({
			id,
			title: `Stateful Web Search ${year}`,
			authors: ["Web Researcher"],
			year,
			identifiers: {},
			links: [],
			provenance: [{ provider: "json-import", query: "web-team-search", retrievedAt: new Date().toISOString() }],
			mergedFrom: [],
		});
		const seeded = await fetch(`${teamUrl}/v1/namespaces/security/proposals`, {
			method: "POST",
			headers: { authorization: "Bearer team-search-token", "content-type": "application/json" },
			body: JSON.stringify({ records: [record("web-team-2024", 2024), record("web-team-2025", 2025)] }),
		});
		expect(seeded.status).toBe(200);
		const application = new PaperAgentApplication({ projectRoot: root });
		const local = await startLocalWebServer(application, { staticRoot, sessionToken: "local-session" });
		try {
			const authenticated = (path: string) =>
				fetch(`${local.url}${path}`, { headers: { authorization: "Bearer local-session" } });
			const first = await authenticated("/api/team/search?q=stateful&yearFrom=2024&yearTo=2025&limit=1");
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as {
				namespace: string;
				hits: Array<{ record: PaperRecord }>;
				nextCursor?: string;
			};
			expect(firstBody).toMatchObject({
				namespace: "security",
				hits: [{ record: { id: "web-team-2024" } }],
				nextCursor: "1",
			});
			const second = await authenticated(
				`/api/team/search?q=stateful&yearFrom=2024&yearTo=2025&limit=1&cursor=${firstBody.nextCursor}`,
			);
			expect(second.status).toBe(200);
			expect(await second.json()).toMatchObject({ hits: [{ record: { id: "web-team-2025" } }] });
		} finally {
			await local.close();
			await application.close();
			await new Promise<void>((resolve) => teamServer.close(() => resolve()));
			if (originalToken === undefined) delete process.env[envName];
			else process.env[envName] = originalToken;
		}
	});
});
