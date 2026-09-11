import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import { ResearchNotebook } from "../../research/application/research-notebook.ts";
import type { ConfirmationGrant, OperationPlan, PreparedOperation } from "../../shared/application/operation-consent.ts";
import { WikiWorkspace } from "../../wiki/application/wiki-workspace.ts";
import type { WikiIngestRequest, WikiIngestPreview, WikiSearchOptions } from "../../wiki/domain/wiki-types.ts";
import { PaperAgentTeamOperations } from "./paper-agent-team-operations.ts";

export interface PreparedWikiIngest {
	preview: WikiIngestPreview;
	operation: PreparedOperation;
}

interface ObsidianConfig {
	vaults?: Record<string, { path?: string; ts?: number; open?: boolean }>;
	[key: string]: unknown;
}

export function defaultObsidianConfigPath(): string {
	if (process.platform === "win32") {
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
	}
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian", "obsidian.json");
}

export async function ensureObsidianVault(vaultPath: string, configPath = defaultObsidianConfigPath()): Promise<string> {
	const absoluteVaultPath = resolve(vaultPath);
	const normalizedPath = absoluteVaultPath.replaceAll("\\", "/").toLowerCase();
	let config: ObsidianConfig = {};
	try {
		config = JSON.parse(await readFile(configPath, "utf8")) as ObsidianConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const vaults = config.vaults && typeof config.vaults === "object" ? config.vaults : {};
	let selectedId: string | undefined;
	for (const [id, vault] of Object.entries(vaults)) {
		if (typeof vault?.path === "string" && vault.path.replaceAll("\\", "/").toLowerCase() === normalizedPath) {
			selectedId = id;
			break;
		}
	}
	selectedId ??= randomBytes(8).toString("hex");
	vaults[selectedId] = { ...vaults[selectedId], path: absoluteVaultPath, ts: vaults[selectedId]?.ts ?? Date.now() };
	for (const [id, vault] of Object.entries(vaults)) {
		if (id === selectedId) vault.open = true;
		else delete vault.open;
	}
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ ...config, vaults }, null, 2)}\n`, "utf8");
	return selectedId;
}

export abstract class PaperAgentWiki extends PaperAgentTeamOperations {
	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.wikiWorkspace().initialize();
		await super.initialize();
	}

	wikiWorkspace(namespace = this.defaultNamespace): WikiWorkspace {
		const store = this.personalStore(namespace);
		const notebook = new ResearchNotebook(store);
		return new WikiWorkspace(this.dataRoot, namespace, {
			resolvePaper: async (id) => {
				const record = await store.getPaper(id);
				if (!record) return undefined;
				const versions = await store.listPaperVersions(id);
				const preferred = versions.find((version) => version.isPreferred) ?? versions[0];
				return {
					kind: "paper",
					id,
					title: record.title,
					version: preferred?.sha256 ?? "metadata",
					updatedAt: preferred?.retrievedAt ?? record.curation?.reading?.updatedAt,
				};
			},
			resolveNote: async (id) => {
				const note = await notebook.get(id);
				return note
					? {
							kind: "note",
							id,
							title: note.title,
							version: note.contentHash,
							revision: note.revision,
							updatedAt: note.updatedAt,
						}
					: undefined;
			},
		});
	}

	async listWikiPages(namespace = this.defaultNamespace, options: WikiSearchOptions = {}) {
		return this.wikiWorkspace(namespace).search(options);
	}

	async getWikiPage(id: string, namespace = this.defaultNamespace) {
		return this.wikiWorkspace(namespace).get(id);
	}

	async lintWiki(namespace = this.defaultNamespace) {
		return this.wikiWorkspace(namespace).lint();
	}

	private wikiIngestPlan(preview: WikiIngestPreview): OperationPlan {
		const creates = preview.changes.filter((change) => change.action === "create").length;
		const updates = preview.changes.filter((change) => change.action === "update").length;
		const conflicts = preview.changes.filter((change) => change.action === "conflict").length;
		return {
			kind: "wiki-write",
			summary: `${preview.summary} (${creates} create, ${updates} update)`,
			actor: "interactive-user",
			targets: preview.changes.map((change) => ({
				label: change.pageId ? "Wiki page" : "New Wiki page",
				value: `${preview.namespace}/${change.title}`,
				risk: conflicts ? "high" : "medium",
			})),
			details: {
				namespace: preview.namespace,
				previewFingerprint: preview.fingerprint,
				changes: preview.changes.map((change) => ({
					action: change.action,
					pageId: change.pageId,
					title: change.title,
					type: change.type,
					relativePath: change.relativePath,
					evidenceIds: change.evidence.map((item) => item.id),
				})),
				issues: preview.issues,
			},
		};
	}

	async prepareWikiIngest(request: WikiIngestRequest, namespace?: string): Promise<PreparedWikiIngest> {
		const resolvedNamespace = namespace ?? request.namespace ?? this.defaultNamespace;
		const preview = await this.wikiWorkspace(resolvedNamespace).previewIngest({
			...request,
			namespace: resolvedNamespace,
		});
		return {
			preview,
			operation: await this.consent.prepare(this.wikiIngestPlan(preview)),
		};
	}

	async ingestWikiPages(request: WikiIngestRequest, grant: ConfirmationGrant, namespace?: string) {
		const prepared = await this.prepareWikiIngest(request, namespace);
		if (prepared.preview.changes.some((change) => change.action === "conflict")) {
			throw new Error(prepared.preview.issues.map((issue) => issue.message).join("; "));
		}
		await this.consent.consume(grant, this.wikiIngestPlan(prepared.preview));
		return this.wikiWorkspace(prepared.preview.namespace).applyIngest(prepared.preview);
	}

	async openWiki(action: "folder" | "obsidian", namespace = this.defaultNamespace) {
		const workspace = this.wikiWorkspace(namespace);
		await workspace.initialize();
		if (action === "folder") {
			const command =
				process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
			const result = await this.executor.exec(command, [workspace.directory], { detached: true });
			if (result.code !== 0 || result.killed) throw new Error(result.stderr || "Could not open Wiki directory");
			return { opened: true, path: workspace.directory };
		}
		const configured = (await loadPaperAgentConfig(this.projectRoot)).wiki.obsidianPath;
		if (!configured) throw new Error("请先在设置中配置 Obsidian 路径");
		const configuredStat = await stat(configured).catch(() => undefined);
		const command = configuredStat?.isDirectory()
			? join(configured, process.platform === "win32" ? "Obsidian.exe" : "obsidian")
			: configured;
		const vaultId = await ensureObsidianVault(workspace.directory);
		const uri = `obsidian://open?vault=${encodeURIComponent(vaultId)}`;
		const result =
			process.platform === "darwin"
				? await this.executor.exec("open", [uri], { detached: true })
				: process.platform === "linux"
					? await this.executor.exec("xdg-open", [uri], { detached: true })
					: await this.executor.exec(command, [uri], { detached: true });
		if (result.code !== 0 || result.killed) throw new Error(result.stderr || "Could not open Wiki in Obsidian");
		return { opened: true, path: workspace.directory, command, vaultId };
	}
}
