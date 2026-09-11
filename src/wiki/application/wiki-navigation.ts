import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { WikiPage, WikiPageType, WikiTreeNode } from "../domain/wiki-types.ts";
import {
	WIKI_INDEX_FILENAME,
	WIKI_LOG_FILENAME,
	WIKI_RESERVED_FILES,
	WIKI_TYPE_DIRECTORIES,
	parseWikiPage,
} from "./wiki-page-codec.ts";

export interface WikiLogEntry {
	action: "create" | "update";
	pageId: string;
	title: string;
	type: WikiPageType;
	status: string;
	evidenceIds: string[];
}

const sectionTitles: Record<WikiPageType, string> = {
	topic: "Topics",
	concept: "Concepts",
	method: "Methods",
	system: "Systems",
	dataset: "Datasets",
	synthesis: "Syntheses",
	question: "Questions",
};

export async function ensureWikiNavigationFiles(directory: string): Promise<void> {
	await Promise.all(
		Object.values(WIKI_TYPE_DIRECTORIES).map((child) => mkdir(resolve(directory, child), { recursive: true })),
	);
	await ensureWikiLogFile(directory);
	const indexPath = resolve(directory, WIKI_INDEX_FILENAME);
	try {
		await access(indexPath);
	} catch {
		await writeWikiIndex(directory, []);
	}
}

async function ensureWikiLogFile(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const logPath = resolve(directory, WIKI_LOG_FILENAME);
	try {
		await access(logPath);
	} catch {
		await writeFile(logPath, "# Research Wiki change log\n\nAppend-only record of page writes.\n", "utf8");
	}
}

export async function writeWikiIndex(directory: string, pages: WikiPage[]): Promise<void> {
	const lines = [
		"# Research Wiki Index",
		"",
		"> Generated from Markdown pages. This file is for navigation only; use page evidence for claims.",
		"",
	];
	for (const type of Object.keys(sectionTitles) as WikiPageType[]) {
		const entries = pages
			.filter((page) => page.type === type)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		lines.push(`## ${sectionTitles[type]}`, "");
		if (!entries.length) {
			lines.push("_No pages yet._", "");
			continue;
		}
		for (const page of entries) {
			lines.push(
				`- [[${page.title}]] \`${page.id}\` - ${page.status}; evidence: ${page.evidence.map((item) => item.id).join(", ") || "none"}`,
			);
		}
		lines.push("");
	}
	await mkdir(directory, { recursive: true });
	await writeFile(resolve(directory, WIKI_INDEX_FILENAME), `${lines.join("\n")}\n`, "utf8");
}

export async function appendWikiLog(directory: string, entries: WikiLogEntry[]): Promise<void> {
	if (!entries.length) return;
	await ensureWikiLogFile(directory);
	const lines = entries.map(
		(entry) =>
			`- ${new Date().toISOString()} | ${entry.action} | [[${entry.title}]] | \`${entry.pageId}\` | ${entry.type} | ${entry.status} | ${entry.evidenceIds.join(", ") || "no evidence"}`,
	);
	await appendFile(resolve(directory, WIKI_LOG_FILENAME), `${lines.join("\n")}\n`, "utf8");
}

export function wikiTypeDirectory(type: WikiPageType): string {
	return WIKI_TYPE_DIRECTORIES[type];
}

export async function buildWikiTree(directory: string): Promise<WikiTreeNode[]> {
	return directoryChildren(directory, directory);
}

async function directoryChildren(root: string, directory: string): Promise<WikiTreeNode[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nodes: WikiTreeNode[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
		const path = resolve(directory, entry.name);
		const relativePath = relative(root, path).replaceAll("\\", "/");
		if (entry.isDirectory()) {
			nodes.push({
				name: entry.name,
				path: relativePath,
				kind: "folder",
				children: await directoryChildren(root, path),
			});
			continue;
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
		if (WIKI_RESERVED_FILES.has(entry.name.toLowerCase())) {
			nodes.push({ name: entry.name, path: relativePath, kind: "file" });
			continue;
		}
		try {
			const page = parseWikiPage(await readFile(path, "utf8"), relativePath);
			nodes.push({
				name: entry.name,
				path: relativePath,
				kind: "page",
				id: page.id,
				title: page.title,
				type: page.type,
				status: page.status,
			});
		} catch {
			nodes.push({ name: entry.name, path: relativePath, kind: "file" });
		}
	}
	return nodes.sort((left, right) => {
		if (left.kind === "folder" && right.kind !== "folder") return -1;
		if (left.kind !== "folder" && right.kind === "folder") return 1;
		return left.name.localeCompare(right.name);
	});
}
