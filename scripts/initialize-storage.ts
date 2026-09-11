import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPaperAgentConfig } from "../src/config/application/config-service.ts";
import { WikiWorkspace } from "../src/wiki/application/wiki-workspace.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadPaperAgentConfig(projectRoot);
const dataRoot = resolve(config.storage.dataRoot ?? join(projectRoot, ".paper-agent"));
const workspace = new WikiWorkspace(dataRoot, config.storage.defaultNamespace);
await workspace.initialize();
console.log(`Wiki storage is ready: ${workspace.directory}`);
