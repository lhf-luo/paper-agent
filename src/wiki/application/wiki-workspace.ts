import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname as pathDirname, relative, resolve } from "node:path";
import { normalizedWikiLabel, wikiLineDiff } from "../domain/wiki-content.ts";
import {
	type IngestWikiPageInput,
	isWikiEvidenceKind,
	isWikiPageType,
	type WikiChangePreview,
	type WikiEvidence,
	type WikiIngestPreview,
	type WikiIngestRequest,
	type WikiIngestResult,
	type WikiLintIssue,
	type WikiPage,
	type WikiPageMetadata,
	type WikiSearchOptions,
	type WikiSearchResult,
	type WikiSourceSnapshot,
	type WikiSyncResult,
} from "../domain/wiki-types.ts";
import { WikiIndex } from "../infrastructure/wiki-index.ts";
import {
	MAX_WIKI_PAGE_BYTES,
	boundedText,
	changeSetFingerprint,
	evidencePaperIds,
	evidenceSourceIds,
	isHttpUrl,
	issue,
	markdownFiles,
	newWikiRelativePath,
	nextEvidenceId,
	parseWikiPage,
	previewPage,
	renderWikiPage,
	safeWikiPath,
	uniqueStrings,
	validateEvidenceClaims,
	writeAtomic,
} from "./wiki-page-codec.ts";
import { lintWikiPages } from "./wiki-lint.ts";
import { appendWikiLog, buildWikiTree, ensureWikiNavigationFiles, writeWikiIndex } from "./wiki-navigation.ts";
import { restoreWikiFiles, withWikiWriteLock } from "./wiki-write-lock.ts";

export interface WikiSourceResolver {
	resolvePaper?(id: string): Promise<WikiSourceSnapshot | undefined>;
	resolveNote?(id: string): Promise<WikiSourceSnapshot | undefined>;
	hasPaper?(id: string): Promise<boolean>;
	hasNote?(id: string): Promise<boolean>;
}

export class WikiWorkspace {
	readonly root: string;
	readonly directory: string;
	readonly databasePath: string;
	private readonly namespace: string;
	private readonly index: WikiIndex;
	private readonly sources?: WikiSourceResolver;

	constructor(dataRoot: string, namespace: string, sources?: WikiSourceResolver) {
		this.root = resolve(dataRoot, "wiki");
		this.directory = resolve(this.root, namespace);
		this.databasePath = resolve(this.root, "wiki.sqlite");
		this.namespace = namespace;
		this.sources = sources;
		this.index = new WikiIndex(this.databasePath);
	}

	async initialize(): Promise<void> {
		await ensureWikiNavigationFiles(this.directory);
		await this.index.initialize();
	}
	async sync(): Promise<WikiSyncResult> {
		const scanned = await this.scanPages();
		await writeWikiIndex(this.directory, scanned.pages);
		await this.index.replaceNamespace(this.namespace, scanned.pages);
		const issues = [
			...scanned.issues,
			...(await lintWikiPages(scanned.pages, (kind, id) => this.resolveSnapshot(kind, id))),
		];
		const indexedCount = await this.index.count(this.namespace);
		if (indexedCount !== scanned.pages.length) {
			issues.push({
				severity: "error",
				code: "index-mismatch",
				path: ".",
				message: `Markdown pages: ${scanned.pages.length}; indexed pages: ${indexedCount}`,
			});
		}
		return { pageCount: scanned.pages.length, issues, indexedAt: new Date().toISOString() };
	}

	async search(options: WikiSearchOptions = {}): Promise<WikiSearchResult> {
		const sync = await this.sync();
		const result = await this.index.search(this.namespace, options);
		return { ...result, tree: await buildWikiTree(this.directory), sync };
	}

	async get(
		id: string,
	): Promise<{ page: WikiPage; backlinks: Array<{ id: string; title: string }>; related: WikiPage[] } | undefined> {
		await this.sync();
		const relativePath = await this.index.pathFor(this.namespace, id);
		if (!relativePath) return undefined;
		const path = safeWikiPath(this.directory, relativePath);
		const page = parseWikiPage(await readFile(path, "utf8"), relativePath);
		const related = (
			await Promise.all(
				(await this.index.neighbors(this.namespace, page.id)).map(async (item) => {
					try {
						const path = safeWikiPath(this.directory, item.relativePath);
						return parseWikiPage(await readFile(path, "utf8"), item.relativePath);
					} catch {
						return undefined;
					}
				}),
			)
		).filter((item): item is WikiPage => Boolean(item));
		return {
			page,
			backlinks: await this.index.backlinks(this.namespace, [page.title, ...page.aliases]),
			related: related.filter((item): item is WikiPage => Boolean(item)),
		};
	}

	async lint(): Promise<WikiSyncResult> {
		return this.sync();
	}

	async previewIngest(request: WikiIngestRequest): Promise<WikiIngestPreview> {
		await this.initialize();
		const scan = await this.scanPages();
		const existingPages = scan.pages;
		const changes: WikiChangePreview[] = [];
		const normalizedChanges: IngestWikiPageInput[] = [];
		const sourceCache = new Map<string, Promise<WikiSourceSnapshot | undefined>>();

		for (const input of request.changes) {
			const normalized = await this.normalizeInput(input, sourceCache);
			normalizedChanges.push(normalized.change);
			changes.push(normalized.preview);
		}

		const labels = new Map<string, WikiPage>();
		for (const page of existingPages) {
			for (const label of [page.title, ...page.aliases]) {
				const key = normalizedWikiLabel(label);
				if (key && !labels.has(key)) labels.set(key, page);
			}
		}
		for (const change of changes) {
			if (change.action === "conflict") continue;
			const existing = change.pageId ? existingPages.find((page) => page.id === change.pageId) : undefined;
			for (const label of [change.title, ...(change.change.aliases ?? [])]) {
				const key = normalizedWikiLabel(label);
				const owner = labels.get(key);
				if (owner && owner.id !== existing?.id) {
					change.issues.push({
						severity: "error",
						code: "duplicate-title-alias",
						path: change.relativePath ?? change.title,
						message: `名称或别名已被页面 ${owner.title} (${owner.id}) 使用：${label}`,
						pageId: existing?.id,
					});
					change.action = "conflict";
				}
				if (key) labels.set(key, existing ?? previewPage(change));
			}
		}

		const proposed = new Map<string, WikiPage>(
			existingPages.map((page) => [page.id, page]),
		);
		for (const change of changes) {
			const existing = change.pageId ? proposed.get(change.pageId) : undefined;
			const page = previewPage(change, existing);
			if (!existing) proposed.set(page.id, page);
			else proposed.set(page.id, page);
		}
		const allLabels = new Map<string, string[]>();
		for (const page of proposed.values()) {
			for (const label of [page.title, ...page.aliases]) {
				const key = normalizedWikiLabel(label);
				allLabels.set(key, [...(allLabels.get(key) ?? []), page.id]);
			}
		}
		for (const change of changes) {
			const missing = (change.change.markdown.match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g) ?? []).map(
				(link) =>
					link
						.slice(2, -2)
						.split("|")[0]
						.split("#")[0]
						.trim(),
			);
			for (const link of missing) {
				if (!allLabels.has(normalizedWikiLabel(link))) {
					change.issues.push({
						severity: "warning",
						code: "broken-link",
						path: change.relativePath ?? change.title,
						message: `未找到链接页面：[[${link}]]`,
					});
				}
			}
			if (change.issues.some((issue) => issue.severity === "error")) change.action = "conflict";
		}

		const issues = changes.flatMap((change) => change.issues);
		const fingerprint = changeSetFingerprint(this.namespace, request.summary, normalizedChanges);
		return {
			namespace: this.namespace,
			summary: request.summary,
			fingerprint,
			generatedAt: new Date().toISOString(),
			changes,
			issues,
		};
	}

	async applyIngest(preview: WikiIngestPreview): Promise<WikiIngestResult> {
		if (preview.namespace !== this.namespace) throw new Error("Wiki preview namespace does not match workspace");
		if (preview.changes.some((change) => change.action === "conflict")) {
			throw new Error("Wiki change set contains conflicts; resolve the preview before applying");
		}
		return withWikiWriteLock(this.root, async () => {
			const current = await this.previewIngest({
				namespace: this.namespace,
				summary: preview.summary,
				changes: preview.changes.map((change) => change.change),
			});
			if (current.fingerprint !== preview.fingerprint) {
				throw new Error("Wiki change set changed since preview; run preview again");
			}
			if (current.changes.some((change) => change.action === "conflict")) {
				throw new Error("Wiki change set now contains conflicts; run preview again");
			}
			const actionable = current.changes.filter((change) => change.action === "create" || change.action === "update");
			if (!actionable.length) return { pages: [], previewFingerprint: preview.fingerprint };

			const existingPages = await this.scanPages().then((result) => result.pages);
			const staged: Array<{ path: string; content: string }> = [];
			const backups = new Map<string, string | undefined>();
			const planned: Array<{ change: WikiChangePreview; path: string; metadata: WikiPageMetadata }> = [];
			const reservedPaths = new Set<string>();
			for (const change of actionable) {
				const existing = change.pageId ? existingPages.find((page) => page.id === change.pageId) : undefined;
				const metadata: WikiPageMetadata = {
					id: existing?.id ?? `wiki-${randomUUID()}`,
					title: change.title,
					type: change.type,
					status: existing?.status === "reviewed" || existing?.status === "conflicted" ? "needs-review" : (existing?.status ?? "draft"),
					aliases: uniqueStrings(change.change.aliases ?? []),
					tags: uniqueStrings(change.change.tags ?? []),
					sourceNoteIds: [],
					paperIds: [],
					evidence: change.evidence,
					createdAt: existing?.createdAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				metadata.sourceNoteIds = evidenceSourceIds(metadata.evidence, "note");
				metadata.paperIds = evidencePaperIds(metadata.evidence);
				let relativePath =
					existing?.relativePath ??
					(await newWikiRelativePath(metadata, async (candidate) =>
						Boolean(await stat(safeWikiPath(this.directory, candidate)).catch(() => undefined)),
					));
				if (reservedPaths.has(relativePath)) {
					const extension = relativePath.toLowerCase().endsWith(".md") ? ".md" : "";
					relativePath = `${relativePath.slice(0, -extension.length) || "page"} [${metadata.id.slice(-8)}]${extension}`;
				}
				reservedPaths.add(relativePath);
				const path = safeWikiPath(this.directory, relativePath);
				const content = renderWikiPage(metadata, change.change.markdown);
				staged.push({ path, content });
				planned.push({ change, path, metadata });
			}

			try {
				for (const item of staged) {
					backups.set(item.path, await readFile(item.path, "utf8").catch(() => undefined));
					await mkdir(pathDirname(item.path), { recursive: true });
					await writeAtomic(item.path, item.content);
				}
				const synced = await this.sync();
				const changedPaths = new Set(planned.map((item) => relative(this.directory, item.path).replaceAll("\\", "/")));
				const introducedErrors = synced.issues.filter(
					(issue) => issue.severity === "error" && changedPaths.has(issue.path),
				);
				if (introducedErrors.length) {
					throw new Error(`Wiki write produced lint errors: ${introducedErrors.map((issue) => issue.message).join("; ")}`);
				}
				await appendWikiLog(
					this.directory,
					planned.map((item) => ({
						action: item.change.action === "update" ? "update" : "create",
						pageId: item.metadata.id,
						title: item.metadata.title,
						type: item.metadata.type,
						status: item.metadata.status,
						evidenceIds: item.metadata.evidence.map((evidence) => evidence.id),
					})),
				);
			} catch (error) {
				await restoreWikiFiles(backups);
				await this.sync().catch(() => undefined);
				throw error;
			}
			const pages = (
				await Promise.all(
					planned.map(async (item) => {
						const found = await this.get(item.metadata.id);
						return found?.page;
					}),
				)
			).filter((page): page is WikiPage => Boolean(page));
			return { pages, previewFingerprint: preview.fingerprint };
		});
	}

	async ingest(input: IngestWikiPageInput): Promise<WikiPage> {
		const preview = await this.previewIngest({
			namespace: this.namespace,
			summary: input.pageId ? `Update ${input.title}` : `Create ${input.title}`,
			changes: [input],
		});
		if (preview.changes.some((change) => change.action === "conflict")) {
			throw new Error(preview.issues.map((issue) => issue.message).join("; "));
		}
		const result = await this.applyIngest(preview);
		const page = result.pages[0];
		if (!page) throw new Error("Wiki page was not written");
		return page;
	}

	private async normalizeInput(
		input: IngestWikiPageInput,
		sourceCache: Map<string, Promise<WikiSourceSnapshot | undefined>>,
	): Promise<{ change: IngestWikiPageInput; preview: WikiChangePreview }> {
		const title = boundedText(input.title, "title", 300);
		if (!isWikiPageType(input.type)) throw new Error(`Unsupported Wiki page type: ${String(input.type)}`);
		const markdown = boundedText(input.markdown, "markdown", MAX_WIKI_PAGE_BYTES);
		const aliases = uniqueStrings(input.aliases ?? []);
		const tags = uniqueStrings(input.tags ?? []);
		const evidence = await this.normalizeEvidence(input, sourceCache);
		const normalized: IngestWikiPageInput = {
			pageId: input.pageId,
			expectedContentHash: input.expectedContentHash,
			title,
			type: input.type,
			markdown,
			aliases,
			tags,
			evidence: evidence.values,
		};
		const existing = input.pageId ? (await this.scanPages()).pages.find((page) => page.id === input.pageId) : undefined;
		const issues: WikiLintIssue[] = [...evidence.issues];
		const oldMarkdown = existing?.markdown ?? "";
		const diff = wikiLineDiff(oldMarkdown, markdown);
		const same =
			existing &&
			existing.title === title &&
			existing.type === input.type &&
			JSON.stringify(existing.aliases) === JSON.stringify(aliases) &&
			JSON.stringify(existing.tags) === JSON.stringify(tags) &&
			existing.markdown === markdown &&
			JSON.stringify(existing.evidence) === JSON.stringify(evidence.values);
		let action: WikiChangePreview["action"] = "create";
		if (existing) {
			if (same) action = "no-op";
			else if (!input.expectedContentHash || input.expectedContentHash !== existing.contentHash) {
				action = "conflict";
				issues.push({
					severity: "error",
					code: "invalid-frontmatter",
					path: existing.relativePath,
					message: "页面在预览前发生变化或缺少 expected_content_hash",
					pageId: existing.id,
				});
			} else action = "update";
		}
		validateEvidenceClaims(markdown, evidence.values, issues);
		if (action !== "no-op" && evidence.values.length === 0) {
			issues.push({
				severity: "warning",
				code: "missing-source-list",
				path: existing?.relativePath ?? title,
				message: "页面没有声明级证据来源",
			});
		}
		if (issues.some((issue) => issue.severity === "error")) action = "conflict";
		return {
			change: normalized,
			preview: {
				action,
				pageId: existing?.id,
				title,
				type: input.type,
				relativePath: existing?.relativePath,
				expectedContentHash: input.expectedContentHash,
				currentContentHash: existing?.contentHash,
				diff,
				evidence: evidence.values,
				sourceSnapshots: evidence.snapshots,
				issues,
				change: normalized,
			},
		};
	}

	private async normalizeEvidence(
		input: IngestWikiPageInput,
		sourceCache: Map<string, Promise<WikiSourceSnapshot | undefined>>,
	): Promise<{ values: WikiEvidence[]; snapshots: WikiSourceSnapshot[]; issues: WikiLintIssue[] }> {
		const values: WikiEvidence[] = [];
		const snapshots: WikiSourceSnapshot[] = [];
		const issues: WikiLintIssue[] = [];
		const sourceEvidence = [...(input.evidence ?? [])];
		const legacyPaperIds = uniqueStrings(input.paperIds ?? []);
		const legacyNoteIds = uniqueStrings(input.sourceNoteIds ?? []);
		for (const paperId of legacyPaperIds) {
			sourceEvidence.push({
				id: nextEvidenceId(sourceEvidence),
				kind: "paper",
				sourceId: paperId,
				locator: {},
			});
		}
		for (const noteId of legacyNoteIds) {
			sourceEvidence.push({
				id: nextEvidenceId(sourceEvidence),
				kind: "note",
				sourceId: noteId,
				locator: {},
			});
		}
		const seen = new Set<string>();
		for (const raw of sourceEvidence) {
			const evidence = {
				id: String(raw.id ?? "").trim(),
				kind: raw.kind,
				...(raw.sourceId ? { sourceId: raw.sourceId.trim() } : {}),
				...(raw.paperId ? { paperId: raw.paperId.trim() } : {}),
				...(raw.version ? { version: raw.version.trim() } : {}),
				locator: raw.locator ?? {},
			} as WikiEvidence;
			if (!/^E[1-9]\d*$/.test(evidence.id)) {
				issues.push(issue("error", "invalid-evidence-locator", `证据 ID 必须使用 E1、E2 格式：${evidence.id}`, evidence.id));
				continue;
			}
			if (seen.has(evidence.id)) {
				issues.push(issue("error", "invalid-evidence-locator", `证据 ID 重复：${evidence.id}`, evidence.id));
				continue;
			}
			seen.add(evidence.id);
			if (!isWikiEvidenceKind(evidence.kind)) {
				issues.push(issue("error", "invalid-evidence-locator", `不支持证据类型：${String(evidence.kind)}`, evidence.id));
				continue;
			}
			const resolved = await this.resolveEvidence(evidence, sourceCache);
			values.push(resolved.evidence);
			snapshots.push(...resolved.snapshots);
			issues.push(...resolved.issues);
		}
		return { values, snapshots, issues };
	}

	private async resolveEvidence(
		evidence: WikiEvidence,
		sourceCache: Map<string, Promise<WikiSourceSnapshot | undefined>>,
	): Promise<{ evidence: WikiEvidence; snapshots: WikiSourceSnapshot[]; issues: WikiLintIssue[] }> {
		const issues: WikiLintIssue[] = [];
		const snapshots: WikiSourceSnapshot[] = [];
		const locator = evidence.locator ?? {};
		if (evidence.kind === "paper") {
			if (!evidence.sourceId) {
				issues.push(issue("error", "invalid-evidence-locator", "论文证据必须提供 source_id", evidence.id));
			} else {
				const snapshot = await this.sourceSnapshot("paper", evidence.sourceId, sourceCache);
				if (!snapshot) {
					issues.push(issue("error", "missing-source", `个人库中不存在论文：${evidence.sourceId}`, evidence.id));
				} else {
					snapshots.push(snapshot);
					if (!Number.isInteger(locator.pdfPage) || Number(locator.pdfPage) < 1) {
						issues.push(issue("error", "invalid-evidence-locator", "论文证据必须提供正整数 pdf_page", evidence.id));
					}
					if (evidence.version && snapshot.version && evidence.version !== snapshot.version) {
						issues.push(issue("error", "stale-source", `论文版本与当前来源不一致：${evidence.sourceId}`, evidence.id));
					}
					evidence.version = evidence.version ?? snapshot.version;
				}
			}
		} else if (evidence.kind === "note") {
			if (!evidence.sourceId) {
				issues.push(issue("error", "invalid-evidence-locator", "笔记证据必须提供 source_id", evidence.id));
			} else {
				const snapshot = await this.sourceSnapshot("note", evidence.sourceId, sourceCache);
				if (!snapshot) {
					issues.push(issue("error", "missing-source", `调研笔记不存在：${evidence.sourceId}`, evidence.id));
				} else {
					snapshots.push(snapshot);
					if (!evidence.version && snapshot.version) evidence.version = snapshot.version;
					if (evidence.version && snapshot.version && evidence.version !== snapshot.version) {
						issues.push(issue("error", "stale-source", `笔记版本与当前来源不一致：${evidence.sourceId}`, evidence.id));
					}
					if (locator.noteRevision !== undefined && snapshot.revision !== undefined && locator.noteRevision !== snapshot.revision) {
						issues.push(issue("error", "stale-source", `笔记 revision 已变化：${evidence.sourceId}`, evidence.id));
					}
					if (locator.noteHash && snapshot.version && locator.noteHash !== snapshot.version) {
						issues.push(issue("error", "stale-source", `笔记 hash 已变化：${evidence.sourceId}`, evidence.id));
					}
				}
			}
		} else if (evidence.kind === "artifact") {
			if (!evidence.paperId) {
				issues.push(issue("error", "invalid-evidence-locator", "Artifact 证据必须提供 paper_id", evidence.id));
			} else {
				const snapshot = await this.sourceSnapshot("paper", evidence.paperId, sourceCache);
				if (!snapshot) {
					issues.push(issue("error", "missing-source", `Artifact 所属论文不存在：${evidence.paperId}`, evidence.id));
				} else snapshots.push(snapshot);
			}
			if (!locator.commit && !locator.path && !locator.url) {
				issues.push(issue("error", "invalid-evidence-locator", "Artifact 证据必须提供 commit、path 或 url", evidence.id));
			}
		} else if (evidence.kind === "public") {
			if (!isHttpUrl(locator.url)) {
				issues.push(issue("error", "invalid-evidence-locator", "公开来源必须提供 HTTP(S) URL", evidence.id));
			}
		}
		return { evidence, snapshots, issues };
	}

	private async sourceSnapshot(
		kind: "paper" | "note",
		id: string,
		cache: Map<string, Promise<WikiSourceSnapshot | undefined>>,
	): Promise<WikiSourceSnapshot | undefined> {
		const key = `${kind}:${id}`;
		let pending = cache.get(key);
		if (!pending) {
			pending = this.resolveSnapshot(kind, id);
			cache.set(key, pending);
		}
		return pending;
	}

	private async resolveSnapshot(kind: "paper" | "note", id: string): Promise<WikiSourceSnapshot | undefined> {
		if (kind === "paper") {
			if (this.sources?.resolvePaper) return this.sources.resolvePaper(id);
			if (this.sources?.hasPaper && (await this.sources.hasPaper(id))) {
				return { kind: "paper", id, title: id, version: "" };
			}
			return undefined;
		}
		if (this.sources?.resolveNote) return this.sources.resolveNote(id);
		if (this.sources?.hasNote && (await this.sources.hasNote(id))) {
			return { kind: "note", id, title: id, version: "" };
		}
		return undefined;
	}

	private async scanPages(): Promise<{ pages: WikiPage[]; issues: WikiLintIssue[] }> {
		await this.initialize();
		const files = await markdownFiles(this.directory);
		const pages: WikiPage[] = [];
		const issues: WikiLintIssue[] = [];
		const ids = new Map<string, string>();
		for (const path of files) {
			const relativePath = relative(this.directory, path).replaceAll("\\", "/");
			try {
				const fileStat = await stat(path);
				if (fileStat.size > MAX_WIKI_PAGE_BYTES) throw new Error("page exceeds the 2 MB limit");
				const page = parseWikiPage(await readFile(path, "utf8"), relativePath);
				const duplicate = ids.get(page.id);
				if (duplicate) {
					issues.push({
						severity: "error",
						code: "duplicate-id",
						path: relativePath,
						message: `页面 ID 与 ${duplicate} 重复：${page.id}`,
					});
					continue;
				}
				ids.set(page.id, relativePath);
				pages.push(page);
			} catch (error) {
				issues.push({
					severity: "error",
					code: "invalid-frontmatter",
					path: relativePath,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return { pages, issues };
	}

}
