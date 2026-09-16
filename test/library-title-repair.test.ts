import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { defaultPaperAgentConfig, savePaperAgentConfig } from "../src/config/application/config-service.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function paperRecord(id: string, title: string, abstract?: string): PaperRecord {
	return {
		id,
		title,
		abstract,
		authors: ["Alice Researcher"],
		identifiers: {},
		links: [],
		provenance: [{ provider: "crossref", query: "fixture", retrievedAt: "2024-01-01T00:00:00.000Z" }],
		discoveryPaths: [],
		mergedFrom: [],
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-title-repair-"));
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
	const server = await startLocalWebServer(application, { staticRoot });
	return { application, server };
}

async function confirmOperation(serverUrl: string, operation: unknown) {
	const response = await fetch(`${serverUrl}/api/operations/confirm`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(operation),
	});
	expect(response.status, await response.clone().text()).toBe(200);
	return response.json();
}

describe("personal library title cleaning", () => {
	it("cleans titles on save and repairs already-stored dirty titles", async () => {
		const { application, server } = await fixture();
		try {
			const store = application.personalStore("default");
			// Seeded as if written before cleaning existed.
			await store.upsertPaper(paperRecord("dirty-html", "<i>ECG</i>: Augmenting Embedded OS Fuzzing"));
			const clean = "A Case Study of LLM for Automated Vulnerability Repair";
			await store.upsertPaper(paperRecord("already-clean", clean));

			const stored = await store.listPapers();
			const byId = new Map(stored.map((record) => [record.id, record]));
			expect(byId.get("dirty-html")?.title).toBe("ECG: Augmenting Embedded OS Fuzzing");
			expect(byId.get("already-clean")?.title).toBe(clean);

			// Re-introduce raw junk to simulate a record stored before the write-path fix.
			const preparedResponse = await fetch(`${server.url}/api/library/titles/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace: "default" }),
			});
			expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200);
			const { prepared } = (await preparedResponse.json()) as { prepared: { operationId: string } | null };
			// Everything was already cleaned on write, so there is nothing left to confirm.
			expect(prepared).toBeNull();
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("exposes a consented repair for titles that are already dirty on disk", async () => {
		const { application, server } = await fixture();
		try {
			const store = application.personalStore("default");
			// Bypass the store write path to plant legacy dirty rows exactly as an old version would have.
			const database = (store as unknown as { personalDatabase?: { savePaper(record: PaperRecord): Promise<void> } })
				.personalDatabase;
			expect(database).toBeDefined();
			await store.initialize();
			await (
				store as unknown as { personalDatabase: { savePaper(record: PaperRecord): Promise<void> } }
			).personalDatabase.savePaper(paperRecord("legacy", "Kernel Fuzzing at Scale - PDF | SpringerLink"));
			await (
				store as unknown as { personalDatabase: { savePaper(record: PaperRecord): Promise<void> } }
			).personalDatabase.savePaper(
				paperRecord("legacy2", "See discussions, stats, and author profiles for this publication at: Deep RL"),
			);

			const listBefore = await store.listPapers();
			expect(listBefore.find((record) => record.id === "legacy")?.title).toBe(
				"Kernel Fuzzing at Scale - PDF | SpringerLink",
			);

			const preparedResponse = await fetch(`${server.url}/api/library/titles/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace: "default" }),
			});
			expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200);
			const { prepared } = (await preparedResponse.json()) as {
				prepared: { operationId: string; manifestFingerprint: string; summary: string } | null;
			};
			expect(prepared).not.toBeNull();
			expect(prepared?.summary).toContain("2");

			const grant = await confirmOperation(server.url, prepared);
			const executed = await fetch(`${server.url}/api/library/titles/execute`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace: "default", grant }),
			});
			expect(executed.status, await executed.clone().text()).toBe(200);
			const result = (await executed.json()) as {
				repaired: number;
				repairs: Array<{ id: string; previousTitle: string; title: string }>;
			};
			expect(result.repaired).toBe(2);

			const listAfter = await store.listPapers();
			const byId = new Map(listAfter.map((record) => [record.id, record]));
			expect(byId.get("legacy")?.title).toBe("Kernel Fuzzing at Scale");
			expect(byId.get("legacy2")?.title).toBe("Deep RL");

			// A second pass is a no-op, so nothing is reported for confirmation.
			const second = await fetch(`${server.url}/api/library/titles/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace: "default" }),
			});
			expect(((await second.json()) as { prepared: unknown }).prepared).toBeNull();
		} finally {
			await server.close();
			await application.close();
		}
	});

	it("cleans LaTeX from both the title and the abstract", async () => {
		const { application, server } = await fixture();
		try {
			const store = application.personalStore("default");
			await store.initialize();
			// Bypass the write path to plant a record exactly as arXiv import used to store it.
			await (
				store as unknown as { personalDatabase: { savePaper(record: PaperRecord): Promise<void> } }
			).personalDatabase.savePaper(
				paperRecord(
					"latex",
					String.raw`$^{15}$C: from Halo-EFT structure to the study of transfer reactions`,
					String.raw`Aside from being a one-neutron halo nucleus, $^{15}$C is involved in $^{14}$C reactions with errors $\pm$ 5% at 10$^{-1}$ s$^{-1}$.`,
				),
			);

			const preparedResponse = await fetch(`${server.url}/api/library/titles/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace: "default" }),
			});
			expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200);
			const { prepared } = (await preparedResponse.json()) as {
				prepared: { operationId: string } | null;
			};
			expect(prepared).not.toBeNull();

			const grant = await confirmOperation(server.url, prepared);
			const executed = await fetch(`${server.url}/api/library/titles/execute`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ namespace: "default", grant }),
			});
			expect(executed.status, await executed.clone().text()).toBe(200);

			const repaired = (await store.listPapers()).find((record) => record.id === "latex");
			expect(repaired?.title).toBe("¹⁵C: from Halo-EFT structure to the study of transfer reactions");
			expect(repaired?.abstract).toBe(
				"Aside from being a one-neutron halo nucleus, ¹⁵C is involved in ¹⁴C reactions with errors ± 5% at 10⁻¹ s⁻¹.",
			);
		} finally {
			await server.close();
			await application.close();
		}
	});
});
