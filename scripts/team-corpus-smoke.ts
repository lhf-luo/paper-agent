import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteratureStore } from "../src/literature-store.ts";
import type { PaperRecord } from "../src/literature-types.ts";
import { createTeamCorpusServer, hashTeamToken } from "../src/team-corpus-server.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const root = await mkdtemp(join(tmpdir(), "paper-agent-team-smoke-"));
const token = "local-smoke-admin-token";
const namespace = "deployment-smoke";
const server = createTeamCorpusServer({
	root: join(root, "corpus"),
	backupRoot: join(root, "backups"),
	identities: [{ name: "smoke-admin", tokenSha256: hashTeamToken(token), roles: ["admin"] }],
});

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string", "team corpus smoke server did not bind a TCP port");
	const origin = `http://127.0.0.1:${address.port}`;
	const base = `${origin}/v1/namespaces/${namespace}`;
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

	const health = await fetch(`${origin}/health`);
	assert(health.status === 200, `health check failed with HTTP ${health.status}`);
	const healthBody = (await health.json()) as { ok?: boolean; service?: string };
	assert(healthBody.ok === true && healthBody.service === "paper-agent-team-corpus", "unexpected health payload");
	const unauthorized = await fetch(`${base}/search`);
	assert(unauthorized.status === 401, `unauthenticated search returned HTTP ${unauthorized.status}`);
	const traversal = await fetch(`${origin}/v1/namespaces/%252e%252e/search`, { headers });
	assert(traversal.status === 400, `unsafe namespace returned HTTP ${traversal.status}`);

	const record: PaperRecord = {
		id: "paper-team-deployment-smoke",
		title: "Deployment Smoke Record",
		authors: ["Paper Agent"],
		year: 2026,
		identifiers: {},
		publicationType: "Conference",
		links: [{ url: "https://example.org/deployment-smoke.pdf", kind: "pdf", openAccess: true }],
		provenance: [{ provider: "local-pdf", query: "deployment-smoke", retrievedAt: new Date().toISOString() }],
		mergedFrom: [],
	};
	const secondRecord: PaperRecord = {
		...record,
		id: "paper-team-deployment-smoke-2",
		title: "Deployment Smoke Record Two",
		links: [{ url: "https://example.org/deployment-smoke-2", kind: "landing" }],
	};
	const proposal = await fetch(`${base}/proposals`, {
		method: "POST",
		headers,
		body: JSON.stringify({ records: [record, secondRecord] }),
	});
	assert(proposal.status === 200, `proposal smoke failed with HTTP ${proposal.status}`);
	const firstPage = await fetch(`${base}/search?q=deployment&limit=1`, { headers });
	assert(firstPage.status === 200, `search smoke failed with HTTP ${firstPage.status}`);
	const firstPageBody = (await firstPage.json()) as { hits?: unknown[]; nextCursor?: string };
	assert(
		firstPageBody.hits?.length === 1 && firstPageBody.nextCursor === "1",
		"search pagination did not expose cursor",
	);
	const secondPage = await fetch(`${base}/search?q=deployment&limit=1&cursor=${firstPageBody.nextCursor}`, {
		headers,
	});
	const secondPageBody = (await secondPage.json()) as { hits?: unknown[]; nextCursor?: string };
	assert(secondPageBody.hits?.length === 1 && !secondPageBody.nextCursor, "search pagination did not terminate");
	const filtered = await fetch(`${base}/search?q=deployment&type=conference&openAccess=true`, { headers });
	const filteredBody = (await filtered.json()) as { hits?: unknown[] };
	assert(filtered.status === 200 && filteredBody.hits?.length === 1, "search filters were not enforced");
	const review = await fetch(`${base}/reviews`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			paperIds: [record.id, secondRecord.id],
			decision: "team-approved",
			reason: "deployment smoke",
		}),
	});
	assert(review.status === 200, `review smoke failed with HTTP ${review.status}`);

	const backup = await fetch(`${base}/backups`, { method: "POST", headers, body: "{}" });
	assert(backup.status === 200, `backup smoke failed with HTTP ${backup.status}`);
	const backupPath = ((await backup.json()) as { backupPath?: string }).backupPath;
	assert(backupPath, "backup response did not include backupPath");
	const restoredPath = join(root, "restore-drill", namespace);
	await cp(join(backupPath, "namespace"), restoredPath, { recursive: true });
	const restored = new LiteratureStore(restoredPath, "team", namespace);
	const audit = await restored.audit();
	const restoredRecord = await restored.getPaper(record.id);
	assert(audit.manifest.recordCount === 2, "restored backup record count mismatch");
	assert(restoredRecord?.curation?.teamReview?.status === "team-approved", "restored review state mismatch");
	assert(
		(await restored.getPaper(secondRecord.id))?.curation?.teamReview?.status === "team-approved",
		"restored second review state mismatch",
	);

	console.log(
		JSON.stringify({
			ok: true,
			health: healthBody,
			namespace,
			backupRecordCount: audit.manifest.recordCount,
			securityChecks: ["authentication", "namespace-containment", "filtering", "pagination"],
			restoreVerified: true,
		}),
	);
} finally {
	if (server.listening) {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	await rm(root, { recursive: true, force: true });
}
