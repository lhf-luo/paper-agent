import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { validateResearchNoteMarkdown } from "../../research/domain/research-notes.ts";

export interface DiskResearchNote {
	relativePath: string;
	folderRelativePath?: string;
	filenameTitle: string;
	markdown: string;
	modifiedAt: string;
}

export interface ResearchNoteFileScan {
	folderRelativePaths: string[];
	notes: DiskResearchNote[];
	warnings: string[];
}

function isInternalTemporaryName(name: string): boolean {
	return /\.(?:tmp|bak|delete)-[a-f0-9-]+$/i.test(name);
}

export async function scanResearchNoteFiles(dataRoot: string, namespace: string): Promise<ResearchNoteFileScan> {
	const root = join(dataRoot, "notes", namespace);
	const folderRelativePaths: string[] = [];
	const notes: DiskResearchNote[] = [];
	const warnings: string[] = [];

	async function visit(directory: string): Promise<void> {
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			if (isInternalTemporaryName(entry.name)) continue;
			const absolutePath = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				warnings.push(`Skipped symbolic link: ${relative(dataRoot, absolutePath)}`);
				continue;
			}
			if (entry.isDirectory()) {
				folderRelativePaths.push(relative(dataRoot, absolutePath));
				await visit(absolutePath);
				continue;
			}
			if (!entry.isFile() || extname(entry.name).toLocaleLowerCase() !== ".md") continue;
			const markdown = validateResearchNoteMarkdown(await readFile(absolutePath, "utf8"));
			const metadata = await stat(absolutePath);
			const folderRelativePath = directory === root ? undefined : relative(dataRoot, directory);
			notes.push({
				relativePath: relative(dataRoot, absolutePath),
				...(folderRelativePath ? { folderRelativePath } : {}),
				filenameTitle: basename(entry.name, extname(entry.name)),
				markdown,
				modifiedAt: metadata.mtime.toISOString(),
			});
		}
	}

	await visit(root);
	return { folderRelativePaths, notes, warnings };
}
