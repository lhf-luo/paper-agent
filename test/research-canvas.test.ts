import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PaperAgentApplication } from "../src/app/application/paper-agent-application.ts";
import { startLocalWebServer } from "../src/app/presentation/local-web-server.ts";
import { getTeamLeaderNames, getTeamMemberNames } from "../src/canvas/domain/canvas-team.ts";
import { CanvasDocumentError } from "../src/canvas/domain/research-canvas.ts";
import { CanvasRevisionConflict, ResearchCanvasStore } from "../src/canvas/infrastructure/research-canvas-store.ts";
import type { PaperRecord } from "../src/literature/domain/literature-types.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
	for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function store() {
	const root = await mkdtemp(join(tmpdir(), "paper-agent-canvas-"));
	temporaryPaths.push(root);
	return new ResearchCanvasStore(join(root, "personal.sqlite"), "default");
}

describe("research canvas storage", () => {
	it("persists linked nodes and labeled evidence without changing their source records", async () => {
		const repository = await store();
		const board = repository.create("内核漏洞研究");
		const nodes = [
			{
				id: "paper-1",
				kind: "paper",
				x: 0,
				y: 0,
				width: 260,
				height: 145,
				title: "旧标题",
				alias: "画布上的简称",
				entityId: "library-paper-id",
			},
			{
				id: "idea-1",
				kind: "text",
				x: 320,
				y: 30,
				width: 280,
				height: 170,
				title: "研究想法",
				content: "这里有研究缺口",
			},
		];
		const edges = [
			{
				id: "edge-1",
				from: "paper-1",
				to: "idea-1",
				fromSide: "right",
				toSide: "left",
				label: "支持",
				evidence: "论文第 4 页",
			},
		];
		const saved = repository.update(board.id, board.revision, {
			title: board.title,
			nodes,
			edges,
			viewport: board.viewport,
		});
		expect(saved?.revision).toBe(1);
		expect(repository.get(board.id)?.nodes).toEqual(nodes);
		expect(repository.get(board.id)?.edges).toEqual(edges);
		expect(repository.list()).toMatchObject([{ id: board.id, nodeCount: 2 }]);
	});

	it("persists author research fields and still accepts older author cards", async () => {
		const repository = await store();
		const board = repository.create("作者关系");
		const author = {
			id: "author-1",
			kind: "author",
			x: 0,
			y: 0,
			width: 260,
			height: 145,
			title: "Ada Lovelace",
			authorDetails: { researchArea: "程序设计", organization: "Analytical Engine" },
		};
		const olderAuthor = { id: "author-2", kind: "author", x: 300, y: 0, width: 260, height: 145, title: "旧作者" };
		const document = { title: board.title, nodes: [author, olderAuthor], edges: [], viewport: board.viewport };
		const saved = repository.update(board.id, board.revision, document);
		expect(saved?.nodes).toEqual([author, olderAuthor]);
		expect(repository.get(board.id)?.nodes).toEqual([author, olderAuthor]);
		expect(() =>
			repository.update(board.id, saved?.revision ?? 0, {
				...document,
				nodes: [{ ...author, authorDetails: { ...author.authorDetails, researchArea: "x".repeat(301) } }],
			}),
		).toThrow(CanvasDocumentError);
	});

	it("preserves old team cards and validates structured team details", async () => {
		const repository = await store();
		const board = repository.create("研究团队");
		const olderTeam = {
			id: "team-old",
			kind: "team",
			x: 0,
			y: 0,
			width: 260,
			height: 145,
			title: "旧课题组",
			content: "原有简介",
		};
		const team = {
			id: "team-new",
			kind: "team",
			x: 300,
			y: 0,
			width: 260,
			height: 145,
			title: "软件安全实验室",
			content: "研究内核安全",
			teamDetails: {
				institution: "某大学",
				leaderName: "手填负责人",
				researchAreas: "程序分析、漏洞检测",
				homepageUrl: "https://example.com/lab",
				members: ["研究员甲", "真实负责人"],
			},
		};
		const author = {
			id: "author-lead",
			kind: "author",
			x: 600,
			y: 0,
			width: 260,
			height: 145,
			title: "真实负责人",
		};
		const edge = { id: "lead-edge", from: author.id, to: team.id, label: "负责人" };
		const document = {
			title: board.title,
			nodes: [olderTeam, team, author],
			edges: [edge],
			viewport: board.viewport,
		};
		const saved = repository.update(board.id, board.revision, document);
		expect(saved?.nodes).toEqual(document.nodes);
		expect(repository.get(board.id)?.nodes[0]).toEqual(olderTeam);
		expect(getTeamLeaderNames(saved?.nodes ?? [], saved?.edges ?? [], team.id)).toBe("真实负责人");
		expect(getTeamLeaderNames(saved?.nodes ?? [], [], team.id)).toBe("");
		expect(
			getTeamMemberNames(
				saved?.nodes ?? [],
				saved?.edges ?? [],
				team.id,
				team.teamDetails.members,
				team.teamDetails.leaderName,
			),
		).toEqual(["真实负责人", "研究员甲"]);
		expect(
			getTeamMemberNames(
				[...(saved?.nodes ?? []), { ...author, id: "author-member", title: "研究员乙" }],
				[...(saved?.edges ?? []), { id: "member-edge", from: team.id, to: "author-member", label: "成员" }],
				team.id,
				team.teamDetails.members,
				team.teamDetails.leaderName,
			),
		).toEqual(["真实负责人", "研究员甲", "研究员乙"]);
		expect(
			getTeamMemberNames(saved?.nodes ?? [], [], team.id, team.teamDetails.members, team.teamDetails.leaderName),
		).toEqual(["手填负责人", "研究员甲", "真实负责人"]);
		expect(() =>
			repository.update(board.id, saved?.revision ?? 0, {
				...document,
				nodes: [{ ...team, teamDetails: { ...team.teamDetails, homepageUrl: "javascript:alert(1)" } }],
				edges: [],
			}),
		).toThrow(CanvasDocumentError);
		expect(() =>
			repository.update(board.id, saved?.revision ?? 0, {
				...document,
				nodes: [{ ...team, teamDetails: { ...team.teamDetails, members: ["同名", "同名"] } }],
				edges: [],
			}),
		).toThrow(CanvasDocumentError);
		expect(() =>
			repository.update(board.id, saved?.revision ?? 0, {
				...document,
				nodes: [{ ...author, teamDetails: team.teamDetails }],
				edges: [],
			}),
		).toThrow(CanvasDocumentError);
	});

	it("rejects stale saves and malformed relationships", async () => {
		const repository = await store();
		const board = repository.create("关系图");
		const document = { title: board.title, nodes: [], edges: [], viewport: board.viewport };
		repository.update(board.id, 0, document);
		expect(() => repository.update(board.id, 0, document)).toThrow(CanvasRevisionConflict);
		expect(() =>
			repository.update(board.id, 1, {
				...document,
				edges: [{ id: "bad-edge", from: "missing", to: "other", label: "引用" }],
			}),
		).toThrow(CanvasDocumentError);
		expect(() =>
			repository.update(board.id, 1, {
				...document,
				nodes: [
					{ id: "a", kind: "text", x: 0, y: 0, width: 260, height: 145, title: "A" },
					{ id: "b", kind: "text", x: 300, y: 0, width: 260, height: 145, title: "B" },
				],
				edges: [{ id: "bad-side", from: "a", to: "b", fromSide: "top", label: "引用" }],
			}),
		).toThrow(CanvasDocumentError);
		expect(repository.get(board.id)?.revision).toBe(1);
	});

	it("deleting a board leaves other boards intact", async () => {
		const repository = await store();
		const first = repository.create("画布一");
		const second = repository.create("画布二");
		expect(repository.delete(first.id, first.revision)).toBe(true);
		expect(repository.get(first.id)).toBeUndefined();
		expect(repository.get(second.id)?.title).toBe("画布二");
	});

	it("renames and duplicates a complete canvas, then deletes only its owned row", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-canvas-settings-"));
		temporaryPaths.push(root);
		const databasePath = join(root, "personal.sqlite");
		const repository = new ResearchCanvasStore(databasePath, "first");
		const otherNamespace = new ResearchCanvasStore(databasePath, "second");
		const source = repository.create("研究关系");
		const node = {
			id: "text-1",
			kind: "text",
			x: 0,
			y: 0,
			width: 260,
			height: 145,
			title: "想法",
			content: "画布内文本",
			richContent: {
				type: "doc",
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "画布内文本", marks: [{ type: "bold" }] }] },
				],
			},
		};
		const paperNode = {
			id: "paper-1",
			kind: "paper",
			entityId: "library-paper",
			x: 320,
			y: 0,
			width: 260,
			height: 145,
			title: "论文",
		};
		const nodes = [node, paperNode];
		const edges = [
			{
				id: "edge-1",
				from: node.id,
				to: paperNode.id,
				fromSide: "right",
				toSide: "left",
				label: "引用",
				evidence: "第 2 页",
			},
		];
		const viewport = { x: 12, y: -20, scale: 0.8 };
		const saved = repository.update(source.id, source.revision, {
			title: source.title,
			nodes,
			edges,
			viewport,
		});
		const renamed = repository.rename(source.id, saved?.revision ?? -1, "新名称");
		expect(renamed).toMatchObject({ title: "新名称", revision: 2, nodes });
		expect(() => repository.rename(source.id, 1, "过期名称")).toThrow(CanvasRevisionConflict);
		const copy = repository.duplicate(source.id, renamed?.revision ?? -1);
		expect(copy).toMatchObject({ title: "新名称 副本", revision: 0, nodes, edges, viewport });
		expect(copy?.id).not.toBe(source.id);
		expect(repository.rename(copy?.id ?? "", 0, "独立副本")?.revision).toBe(1);
		expect(repository.get(source.id)?.title).toBe("新名称");
		expect(() => repository.duplicate(source.id, 1)).toThrow(CanvasRevisionConflict);
		expect(otherNamespace.get(source.id)).toBeUndefined();
		expect(otherNamespace.get(copy?.id ?? "")).toBeUndefined();
		expect(repository.delete(source.id, renamed?.revision ?? -1)).toBe(true);
		expect(repository.get(source.id)).toBeUndefined();
		expect(repository.get(copy?.id ?? "")?.nodes).toEqual(saved?.nodes);
		expect(repository.update(source.id, renamed?.revision ?? -1, saved)).toBeUndefined();
		expect(repository.delete(copy?.id ?? "", 1)).toBe(true);
		const database = new DatabaseSync(databasePath);
		try {
			const count = database.prepare("SELECT COUNT(*) AS count FROM research_canvases").get() as { count: number };
			expect(count.count).toBe(0);
			// Deleted document pages must be reused instead of growing the file on every create/delete cycle.
			let allocatedPages = 0;
			for (let cycle = 0; cycle < 10; cycle++) {
				const temporary = repository.create("临时画布");
				repository.update(temporary.id, 0, {
					title: temporary.title,
					nodes: [{ ...node, richContent: undefined, content: "内容".repeat(9000) }],
					edges: [],
					viewport,
				});
				expect(repository.delete(temporary.id, 1)).toBe(true);
				const pages = (database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
				if (cycle === 0) allocatedPages = pages;
				else expect(pages).toBe(allocatedPages);
			}
			expect(database.prepare("SELECT COUNT(*) AS count FROM research_canvases").get()).toMatchObject({ count: 0 });
		} finally {
			database.close();
		}
	});

	it("serves namespace-scoped canvas CRUD and reports revision conflicts over HTTP", async () => {
		const root = await mkdtemp(join(tmpdir(), "paper-agent-canvas-api-"));
		temporaryPaths.push(root);
		const application = new PaperAgentApplication({ projectRoot: root, dataRoot: join(root, "data") });
		const server = await startLocalWebServer(application, { staticRoot: root });
		const request = (path: string, method = "GET", body?: unknown) =>
			fetch(`${server.url}${path}`, {
				method,
				...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
			});
		try {
			const paper: PaperRecord = {
				id: "seed-paper",
				title: "Live paper title",
				authors: ["Ada Author"],
				identifiers: {},
				links: [],
				provenance: [{ provider: "local-pdf", query: "test", retrievedAt: "2026-01-01T00:00:00.000Z" }],
				mergedFrom: [],
			};
			await application.personalStore("first").upsertPaper(paper);
			const created = await request("/api/canvases", "POST", { namespace: "first", title: "测试画布" });
			expect(created.status).toBe(201);
			const { canvas } = (await created.json()) as {
				canvas: { id: string; revision: number; title: string; viewport: { x: number; y: number; scale: number } };
			};
			expect((await (await request("/api/canvases?namespace=second")).json()).canvases).toEqual([]);
			const updated = await request(`/api/canvases/${canvas.id}`, "PUT", {
				namespace: "first",
				expectedRevision: 0,
				document: {
					title: "更新画布",
					nodes: [
						{
							id: "paper-node",
							kind: "paper",
							x: 0,
							y: 0,
							width: 260,
							height: 145,
							title: "旧标题",
							entityId: paper.id,
						},
					],
					edges: [],
					viewport: canvas.viewport,
				},
			});
			expect(updated.status).toBe(200);
			const opened = await (await request(`/api/canvases/${canvas.id}?namespace=first`)).json();
			expect(opened.canvas.title).toBe("更新画布");
			expect(opened.references.papers).toMatchObject([{ id: paper.id, title: paper.title }]);
			const copied = await request(`/api/canvases/${canvas.id}/copy`, "POST", {
				namespace: "first",
				expectedRevision: 1,
			});
			expect(copied.status).toBe(201);
			const copy = (await copied.json()).canvas as { id: string; revision: number; title: string; nodes: unknown[] };
			expect(copy).toMatchObject({ title: "更新画布 副本", revision: 0, nodes: opened.canvas.nodes });
			expect((await request(`/api/canvases/${copy.id}?namespace=second`)).status).toBe(404);
			const renamed = await request(`/api/canvases/${canvas.id}`, "PATCH", {
				namespace: "first",
				expectedRevision: 1,
				title: "重新命名",
			});
			expect(renamed.status).toBe(200);
			expect((await renamed.json()).canvas).toMatchObject({ title: "重新命名", revision: 2 });
			expect(
				(
					await request(`/api/canvases/${canvas.id}`, "PUT", {
						namespace: "first",
						expectedRevision: 0,
						document: { title: "过期版本", nodes: [], edges: [], viewport: canvas.viewport },
					})
				).status,
			).toBe(409);
			expect(
				(
					await request(`/api/canvases/${canvas.id}`, "PUT", {
						namespace: "first",
						expectedRevision: 2,
						document: {
							title: "非法连线",
							nodes: [],
							edges: [{ id: "bad", from: "none", to: "other", label: "引用" }],
							viewport: canvas.viewport,
						},
					})
				).status,
			).toBe(400);
			expect((await request(`/api/canvases/${canvas.id}?namespace=second`)).status).toBe(404);
			expect(
				(await request(`/api/canvases/${canvas.id}`, "DELETE", { namespace: "first", expectedRevision: 2 })).status,
			).toBe(200);
			expect((await request(`/api/canvases/${copy.id}?namespace=first`)).status).toBe(200);
			expect(
				(await request(`/api/canvases/${copy.id}`, "DELETE", { namespace: "first", expectedRevision: 0 })).status,
			).toBe(200);
			expect(await application.personalStore("first").getPaper(paper.id)).toMatchObject({ id: paper.id });
		} finally {
			await server.close();
			await application.close();
		}
	});
});
