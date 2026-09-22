import { extractWikiClaims, nearDuplicateLabels, normalizedWikiLabel } from "../domain/wiki-content.ts";
import type { WikiLintIssue, WikiPage, WikiSourceSnapshot } from "../domain/wiki-types.ts";
import { isHttpUrl } from "./wiki-page-codec.ts";

export type WikiSourceLookup = (kind: "paper" | "note", id: string) => Promise<WikiSourceSnapshot | undefined>;

export async function lintWikiPages(pages: WikiPage[], lookup: WikiSourceLookup): Promise<WikiLintIssue[]> {
	const issues: WikiLintIssue[] = [];
	const sourceCache = new Map<string, Promise<WikiSourceSnapshot | undefined>>();
	const snapshot = (kind: "paper" | "note", id: string) => {
		const key = `${kind}:${id}`;
		let pending = sourceCache.get(key);
		if (!pending) {
			pending = lookup(kind, id);
			sourceCache.set(key, pending);
		}
		return pending;
	};
	const labels = new Map<string, WikiPage>();
	for (const page of pages) {
		for (const label of [page.title, ...page.aliases]) {
			const key = normalizedWikiLabel(label);
			const previous = labels.get(key);
			if (previous && previous.id !== page.id) {
				issues.push({
					severity: "error",
					code: "duplicate-title-alias",
					path: page.relativePath,
					message: `${label} 与页面 ${previous.title} 重复`,
					pageId: page.id,
				});
			} else {
				labels.set(key, page);
			}
		}
	}
	for (let leftIndex = 0; leftIndex < pages.length; leftIndex++) {
		const left = pages[leftIndex];
		for (let rightIndex = leftIndex + 1; rightIndex < pages.length; rightIndex++) {
			const right = pages[rightIndex];
			if (left.type === right.type && nearDuplicateLabels(left.title, right.title)) {
				issues.push({
					severity: "warning",
					code: "near-duplicate-page",
					path: right.relativePath,
					message: `页面标题与 ${left.title} 近似重复`,
					pageId: right.id,
				});
			}
		}
	}
	for (const page of pages) {
		const referenced = new Set(extractWikiClaims(page.markdown).flatMap((claim) => claim.evidenceIds));
		const available = new Set(page.evidence.map((item) => item.id));
		if (!page.markdown.trim()) {
			issues.push({
				severity: "warning",
				code: "empty-page",
				path: page.relativePath,
				message: "页面正文为空",
				pageId: page.id,
			});
		}
		for (const claim of page.claims) {
			for (const evidenceId of claim.evidenceIds) {
				if (!available.has(evidenceId)) {
					issues.push({
						severity: "error",
						code: "missing-evidence",
						path: page.relativePath,
						message: `${claim.id} 引用了不存在的证据 ${evidenceId}`,
						pageId: page.id,
						claimId: claim.id,
						evidenceId,
					});
				}
			}
		}
		for (const evidence of page.evidence) {
			if (evidence.legacy) {
				issues.push({
					severity: "warning",
					code: "legacy-source-granularity",
					path: page.relativePath,
					message: `旧式页面级来源 ${evidence.id} 缺少声明级定位`,
					pageId: page.id,
					evidenceId: evidence.id,
				});
			}
			if (!referenced.has(evidence.id) && page.claims.length) {
				issues.push({
					severity: "warning",
					code: "unused-evidence",
					path: page.relativePath,
					message: `证据 ${evidence.id} 没有被正文 claim 引用`,
					pageId: page.id,
					evidenceId: evidence.id,
				});
			}
			if (evidence.kind === "paper" && evidence.sourceId) {
				const source = await snapshot("paper", evidence.sourceId);
				if (!source) {
					issues.push({
						severity: "error",
						code: "missing-source",
						path: page.relativePath,
						message: `个人库论文不存在：${evidence.sourceId}`,
						pageId: page.id,
						evidenceId: evidence.id,
						sourceKind: "paper",
						sourceId: evidence.sourceId,
					});
				} else if (evidence.version && evidence.version !== source.version) {
					issues.push({
						severity: "warning",
						code: "stale-source",
						path: page.relativePath,
						message: `论文来源版本已变化：${evidence.sourceId}`,
						pageId: page.id,
						evidenceId: evidence.id,
					});
				}
			}
			if (evidence.kind === "note" && evidence.sourceId) {
				const source = await snapshot("note", evidence.sourceId);
				if (!source) {
					issues.push({
						severity: "error",
						code: "missing-source",
						path: page.relativePath,
						message: `调研笔记不存在：${evidence.sourceId}`,
						pageId: page.id,
						evidenceId: evidence.id,
						sourceKind: "note",
						sourceId: evidence.sourceId,
					});
				} else if (
					(evidence.version && evidence.version !== source.version) ||
					(evidence.locator.noteRevision !== undefined &&
						source.revision !== undefined &&
						evidence.locator.noteRevision !== source.revision)
				) {
					issues.push({
						severity: "warning",
						code: "stale-source",
						path: page.relativePath,
						message: `笔记来源版本已变化：${evidence.sourceId}`,
						pageId: page.id,
						evidenceId: evidence.id,
					});
				}
			}
			if (evidence.kind === "artifact") {
				if (evidence.paperId && !(await snapshot("paper", evidence.paperId))) {
					issues.push({
						severity: "error",
						code: "missing-source",
						path: page.relativePath,
						message: `Artifact 所属论文不存在：${evidence.paperId}`,
						pageId: page.id,
						evidenceId: evidence.id,
						sourceKind: "paper",
						sourceId: evidence.paperId,
					});
				}
				if (!evidence.locator.commit && !evidence.locator.path && !evidence.locator.url) {
					issues.push({
						severity: "error",
						code: "invalid-evidence-locator",
						path: page.relativePath,
						message: `Artifact 证据 ${evidence.id} 缺少 commit、path 或 url`,
						pageId: page.id,
						evidenceId: evidence.id,
					});
				}
			}
			if (evidence.kind === "public" && !isHttpUrl(evidence.locator.url)) {
				issues.push({
					severity: "error",
					code: "invalid-evidence-locator",
					path: page.relativePath,
					message: `公开来源 ${evidence.id} 缺少 HTTP(S) URL`,
					pageId: page.id,
					evidenceId: evidence.id,
				});
			}
			if (
				!evidence.legacy &&
				evidence.kind === "paper" &&
				(!evidence.sourceId || !evidence.version || !evidence.locator.pdfPage)
			) {
				issues.push({
					severity: "error",
					code: "invalid-evidence-locator",
					path: page.relativePath,
					message: `论文证据 ${evidence.id} 缺少 source_id、version 或 pdf_page`,
					pageId: page.id,
					evidenceId: evidence.id,
				});
			}
		}
		for (const link of page.links) {
			if (normalizedWikiLabel(link) === normalizedWikiLabel(page.title)) {
				issues.push({
					severity: "warning",
					code: "self-link",
					path: page.relativePath,
					message: `页面链接自身：[[${link}]]`,
					pageId: page.id,
				});
			} else if (!labels.has(normalizedWikiLabel(link))) {
				issues.push({
					severity: "warning",
					code: "broken-link",
					path: page.relativePath,
					message: `未找到链接页面：[[${link}]]`,
					pageId: page.id,
				});
			}
		}
		if (
			page.status === "conflicted" &&
			(!/^##\s+.*(争议|矛盾|Contradictions?)/im.test(page.markdown) ||
				!/^##\s+.*(开放问题|未决问题|Open Questions?)/im.test(page.markdown))
		) {
			issues.push({
				severity: "error",
				code: "conflicted-status",
				path: page.relativePath,
				message: "conflicted 页面必须包含争议和开放问题章节",
				pageId: page.id,
			});
		}
		if (!page.evidence.length && !page.paperIds.length && !page.sourceNoteIds.length) {
			issues.push({
				severity: "warning",
				code: "missing-source-list",
				path: page.relativePath,
				message: "页面没有来源",
				pageId: page.id,
			});
		}
	}
	return issues;
}
