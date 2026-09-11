import { loadPaperAgentConfig, savePaperAgentConfig } from "../../../config/application/config-service.ts";

export async function loadZoteroCredentials(projectRoot: string): Promise<{ apiKey?: string; serverId?: string }> {
	const credentials = (await loadPaperAgentConfig(projectRoot)).credentials;
	return { apiKey: credentials?.zoteroLocalApiKey, serverId: credentials?.zoteroServerId };
}

export async function saveZoteroCredentials(
	projectRoot: string,
	credentials: { apiKey?: string; serverId?: string },
): Promise<void> {
	const config = await loadPaperAgentConfig(projectRoot);
	await savePaperAgentConfig(projectRoot, {
		...config,
		credentials: {
			...(config.credentials ?? {}),
			...(credentials.apiKey ? { zoteroLocalApiKey: credentials.apiKey } : {}),
			...(credentials.serverId ? { zoteroServerId: credentials.serverId } : {}),
		},
	});
}

export async function clearZoteroCredentials(projectRoot: string): Promise<void> {
	const config = await loadPaperAgentConfig(projectRoot);
	const { zoteroLocalApiKey: _apiKey, zoteroServerId: _serverId, ...credentials } = config.credentials ?? {};
	await savePaperAgentConfig(projectRoot, { ...config, credentials });
}
