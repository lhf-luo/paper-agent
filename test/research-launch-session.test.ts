import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-research-launch-"));
	temporaryPaths.push(root);
	const config = defaultPaperAgentConfig();
	config.search.providers = [];
	await savePaperAgentConfig(root, config);
	const staticRoot = join(root, "dist", "web");
	await mkdir(staticRoot, { recursive: true });
	await writeFile(join(staticRoot, "index.html"), "<html>Paper Agent</html>");
	const application = new PaperAgentApplication({
		projectRoot: root,
		dataRoot: join(root, ".paper-agent"),
	});
	// A stub service keeps these tests on the routing/draft contract without needing a live model.
	const sessions = new Map<string, Record<string, unknown>>();
	const created: Array<Record<string, unknown>> = [];
	let sentMessages = 0;
	const service = {
		projectRoot: root,
		getConfig: async () => ({ configured: true, credentialsAvailable: true }),
		listSessions: async (filter?: { scope?: string; namespace?: string; paperId?: string }) => {
			const values = [...sessions.values()] as Array<{
				id: string;
				status: string;
				updatedAt: string;
				context?: { namespace: string; paperId: string };
			}>;
			return values
				.filter((session) => {
					if (filter?.scope === "personal") {
						return session.context?.namespace === filter.namespace;
					}
					if (filter?.scope === "paper") {
						return session.context?.namespace === filter.namespace && session.context?.paperId === filter.paperId;
					}
					return !session.context;
				})
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		},
		createSession: async (input: {
			mode: string;
			title?: string;
			context?: { namespace: string; paperId: string };
			thinkingLevel?: string;
		}) => {
			const id = `session-${sessions.size + 1}`;
			const session = {
				id,
				title: input.title ?? id,
				mode: input.mode,
				context: input.context,
				status: "idle",
				createdAt: "2024-01-01T00:00:00.000Z",
				updatedAt: `2024-01-0${sessions.size + 1}T00:00:00.000Z`,
				messages: [],
				tools: [],
				uiRequests: [],
			};
			sessions.set(id, session);
			created.push(session);
			return session;
		},
		getSession: async (id: string) => sessions.get(id),
		sendMessage: async () => {
			sentMessages += 1;
			throw new Error("Auto research must never send a message on its own");
		},
		close: () => undefined,
	};
	const server = await startLocalWebServer(application, { staticRoot, agentService: service as never });
	return {
		application,
		server,
		sessions,
		created,
		getSentMessages: () => sentMessages,
	};
}

interface LaunchResponse {
	session: { id: string };
	draft: string;
	reusedExistingSession: boolean;
	plan: unknown;
}

async function launch(researchUrl: string, paperId: string, namespace: string) {
	const response = await fetch(`${researchUrl}/api/agent/research/start`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ paperId, namespace, depth: "quick" }),
	});
	return { status: response.status, body: (await response.json()) as LaunchResponse };
}

describe("one-click automated research launch", () => {
	it("returns the research prompt as a draft and never sends it", async () => {
		const { application, server, created, getSentMessages } = await fixture();
		try {
			const paper = await seedPaperWithPdf(application, "lab");
			const { status, body } = await launch(server.url, paper.id, "lab");
			expect(status, JSON.stringify(body)).toBe(200);
			expect(body.draft).toContain(paper.id);
			expect(body.reusedExistingSession).toBe(false);
			expect(body.session.id).toBeTruthy();
			// The only session is the one created for the draft.
			expect(created).toHaveLength(1);
			expect(getSentMessages()).toBe(0);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("reuses the most recent personal-library session instead of creating a new one", async () => {
		const { application, server, created, sessions, getSentMessages } = await fixture();
		try {
			const paper = await seedPaperWithPdf(application, "lab");
			const first = await launch(server.url, paper.id, "lab");
			expect(created).toHaveLength(1);
			expect(first.body.reusedExistingSession).toBe(false);
			expect(first.body.session.id).toBeTruthy();

			// Second launch for the same paper must reuse, not add a session.
			const second = await launch(server.url, paper.id, "lab");
			expect(second.status).toBe(200);
			expect(second.body.reusedExistingSession).toBe(true);
			expect(second.body.session.id).toBe(first.body.session.id);
			expect(created).toHaveLength(1);
			expect(sessions.size).toBe(1);
			expect(getSentMessages()).toBe(0);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("never reuses a session bound to another paper", async () => {
		const { application, server, created } = await fixture();
		try {
			const firstPaper = await seedPaperWithPdf(application, "lab", "paper-a");
			const secondPaper = await seedPaperWithPdf(application, "lab", "paper-b");

			const a = await launch(server.url, firstPaper.id, "lab");
			expect(created).toHaveLength(1);
			expect(a.body.reusedExistingSession).toBe(false);

			// paper-b has no associated session, so it must receive a new paper-scoped session.
			const b = await launch(server.url, secondPaper.id, "lab");
			expect(b.body.reusedExistingSession).toBe(false);
			expect(b.body.session.id).not.toBe(a.body.session.id);
			expect(created).toHaveLength(2);
			expect(created[1]?.context).toEqual({ kind: "paper", namespace: "lab", paperId: secondPaper.id });

			// paper-a still reuses its own associated session.
			const again = await launch(server.url, firstPaper.id, "lab");
			expect(again.body.reusedExistingSession).toBe(true);
			expect(again.body.session.id).toBe(a.body.session.id);
			expect(created).toHaveLength(2);

			// Each draft still describes the paper that was launched.
			expect(a.body.draft).toContain(firstPaper.id);
			expect(b.body.draft).toContain(secondPaper.id);
			expect(again.body.draft).toContain(firstPaper.id);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("picks the most recent session among those bound to the same paper", async () => {
		const { application, server, sessions, created } = await fixture();
		try {
			const paperA = await seedPaperWithPdf(application, "lab", "paper-a");
			const paperB = await seedPaperWithPdf(application, "lab", "paper-b");
			const paperC = await seedPaperWithPdf(application, "lab", "paper-c");
			// Pre-existing sessions, e.g. opened from the reader, with interleaved recency.
			const seed = (id: string, paperId: string, updatedAt: string) => {
				sessions.set(id, {
					id,
					title: id,
					mode: "persistent",
					context: { kind: "paper", namespace: "lab", paperId },
					status: "idle",
					createdAt: updatedAt,
					updatedAt,
					messages: [],
					tools: [],
					uiRequests: [],
				});
			};
			seed("a-older", "paper-a", "2024-01-01T00:00:00.000Z");
			seed("b-newest", "paper-b", "2024-03-01T00:00:00.000Z");
			seed("a-newer", "paper-a", "2024-02-01T00:00:00.000Z");

			// paper-a wins over the globally newest session, and uses its own most recent one.
			const launchedA = await launch(server.url, paperA.id, "lab");
			expect(launchedA.body.session.id).toBe("a-newer");
			expect(launchedA.body.reusedExistingSession).toBe(true);

			// paper-b's own session is also the newest overall.
			const launchedB = await launch(server.url, paperB.id, "lab");
			expect(launchedB.body.session.id).toBe("b-newest");

			// paper-c has no associated session, so sessions for paper-a/paper-b must not be reused.
			const launchedC = await launch(server.url, paperC.id, "lab");
			expect(launchedC.body.reusedExistingSession).toBe(false);
			expect(["a-older", "a-newer", "b-newest"]).not.toContain(launchedC.body.session.id);
			expect(created.at(-1)?.context).toEqual({ kind: "paper", namespace: "lab", paperId: paperC.id });
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("does not reuse a session from a different personal namespace", async () => {
		const { application, server, created } = await fixture();
		try {
			const labPaper = await seedPaperWithPdf(application, "lab");
			await launch(server.url, labPaper.id, "lab");
			expect(created).toHaveLength(1);
			// A different namespace has no sessions of its own yet.
			const other = await fetch(`${server.url}/api/agent/sessions?scope=personal&namespace=other`);
			expect(other.status).toBe(200);
			expect(((await other.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("requires namespace for personal scope and accepts it for paper scope", async () => {
		const { application, server } = await fixture();
		try {
			await seedPaperWithPdf(application, "lab");
			const missingNamespace = await fetch(`${server.url}/api/agent/sessions?scope=personal`);
			expect(missingNamespace.status).toBe(400);
			const listed = await fetch(`${server.url}/api/agent/sessions?scope=personal&namespace=lab`);
			expect(listed.status).toBe(200);
		} finally {
			await server.close();
			await application.close();
		}
	});
});

async function seedPaperWithPdf(
	application: PaperAgentApplication,
	namespace: string,
	paperId = "paper-1",
): Promise<{ id: string }> {
	const store = application.personalStore(namespace);
	await store.initialize();
	const body = Buffer.from(`%PDF-1.4\n${paperId}\n%%EOF\n`);
	const blob = await store.putBlob(body);
	await store.upsertPaper({
		id: paperId,
		title: `Fixture Paper ${paperId}`,
		authors: ["Alice Researcher"],
		identifiers: {},
		links: [],
		provenance: [{ provider: "crossref", query: "fixture", retrievedAt: "2024-01-01T00:00:00.000Z" }],
		discoveryPaths: [],
		mergedFrom: [],
	});
	await store.savePaperVersion({
		paperId,
		sourceUrl: "https://example.org/paper.pdf",
		finalUrl: "https://example.org/paper.pdf",
		retrievedAt: "2024-01-01T00:00:00.000Z",
		sha256: blob.sha256,
		bytes: body.length,
		blobPath: blob.path,
		contentType: "application/pdf",
		versionKind: "published",
		isPreferred: true,
	});
	return { id: paperId };
}
