import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiModelService } from "../src/agent/application/pi-model-service.ts";
import { loadPaperAgentConfig } from "../src/config/application/config-service.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await new PiModelService(projectRoot).initialize(await loadPaperAgentConfig(projectRoot));
