import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type RegisteredAgentTool = ToolDefinition<any, any, any>;

export interface AgentToolCatalogEntry {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines: string[];
	parameters?: unknown;
}

export class AgentToolCatalog {
	private readonly tools = new Map<string, RegisteredAgentTool>();

	add(tool: RegisteredAgentTool): void {
		this.tools.set(tool.name, tool);
	}

	entries(): RegisteredAgentTool[] {
		return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	find(query?: string, name?: string): AgentToolCatalogEntry[] {
		if (name) {
			const tool = this.tools.get(name);
			return tool ? [entry(tool, true)] : [];
		}
		const terms = query
			?.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{N}_-]+/gu)
			?.filter(Boolean);
		if (!terms?.length) return this.entries().slice(0, 50).map((tool) => entry(tool, false));
		return this.entries()
			.map((tool) => {
				const fields = [
					tool.name,
					tool.label,
					tool.description,
					tool.promptSnippet ?? "",
					...(tool.promptGuidelines ?? []),
				];
				const haystack = fields.join("\n").toLowerCase();
				const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
				return { tool, score };
			})
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
			.slice(0, 50)
			.map((item) => entry(item.tool, false));
	}
}

export function captureAgentToolCatalog(pi: ExtensionAPI): AgentToolCatalog {
	const catalog = new AgentToolCatalog();
	const original = pi.registerTool.bind(pi);
	pi.registerTool = ((tool: RegisteredAgentTool) => {
		catalog.add(tool);
		original(tool);
	}) as typeof pi.registerTool;
	return catalog;
}

export function registerAgentToolCatalogTool(pi: ExtensionAPI, catalog: AgentToolCatalog): void {
	pi.registerTool({
		name: "inspect_agent_tools",
		label: "Inspect agent tools",
		description:
			"Read the actual Paper Agent extension tools registered in this session. Search by capability, inspect one exact tool, and optionally include its parameter schema and Agent guidelines. This tool is read-only and never executes another tool.",
		promptSnippet: "Discover the exact tools available before planning a multi-step research or Wiki task",
		promptGuidelines: [
			"Use this before Wiki ingestion or whenever a capability may be optional; do not invent tools from memory or stale documentation.",
			"Search by capability terms such as PDF, MinerU, artifact, note, Wiki, evidence, or coverage.",
			"If a required capability is absent, disclose the degradation and continue with available primary sources instead of guessing.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ maxLength: 300 })),
			name: Type.Optional(Type.String({ maxLength: 200 })),
			include_schema: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_toolCallId, params) {
			const results = catalog.find(params.query, params.name).map((item) => {
				if (params.include_schema) return item;
				const { parameters: _parameters, ...withoutSchema } = item;
				return withoutSchema;
			});
			return {
				content: [
					{
						type: "text",
						text: results.length
							? results
									.map((item) => {
										const guidelines = item.promptGuidelines.length
											? `\n  Guidelines: ${item.promptGuidelines.join(" | ")}`
											: "";
										const schema = "parameters" in item ? `\n  Schema: ${JSON.stringify(item.parameters)}` : "";
										return `- ${item.name}: ${item.description}${guidelines}${schema}`;
									})
									.join("\n")
							: "No registered Paper Agent tool matched the requested capability.",
					},
				],
				details: { query: params.query, name: params.name, includeSchema: params.include_schema ?? false, results },
			};
		},
	});
}

export function collectRegisteredTools(registerExtension: (pi: ExtensionAPI) => void): RegisteredAgentTool[] {
	const tools = new Map<string, RegisteredAgentTool>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: RegisteredAgentTool) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerExtension(pi);
	return [...tools.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function entry(tool: RegisteredAgentTool, includeSchema: boolean): AgentToolCatalogEntry {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
		promptGuidelines: [...(tool.promptGuidelines ?? [])],
		...(includeSchema ? { parameters: tool.parameters } : {}),
	};
}
