import type { AgentMessageView, AgentToolView } from "./types.ts";

const RESULT_MD_URL_PATTERN = /\/api\/agent\/results\/[A-Za-z0-9._-]+\.md/;
const RESULT_ROW_COUNT_PATTERN = /"rowCount"\s*:\s*(\d+)/;
const SKILL_PREFIX_PATTERN = /^\/skill:[^\s]+\s*/i;
const MAX_QUERY_LABEL_LENGTH = 56;

export interface AgentResultDocument {
	id: string;
	url: string;
	anchorMessageId?: string;
	query: string;
	sequence: number;
	createdAt: string;
	rowCount?: number;
}

export function parseAgentResultOutput(output: string): { url?: string; rowCount?: number } {
	try {
		const parsed = JSON.parse(output) as { details?: { mdUrl?: unknown; rowCount?: unknown } };
		const url = typeof parsed.details?.mdUrl === "string" ? parsed.details.mdUrl : undefined;
		const rowCount =
			typeof parsed.details?.rowCount === "number" && Number.isInteger(parsed.details.rowCount)
				? parsed.details.rowCount
				: undefined;
		if (url) return { url, rowCount };
	} catch {
		// Tool output can be truncated after the URL and row count.
	}
	const rowCountMatch = output.match(RESULT_ROW_COUNT_PATTERN)?.[1];
	return {
		url: output.match(RESULT_MD_URL_PATTERN)?.[0],
		rowCount: rowCountMatch ? Number.parseInt(rowCountMatch, 10) : undefined,
	};
}

export function agentResultQueryLabel(content: string): string {
	const normalized = content.replace(SKILL_PREFIX_PATTERN, "").replace(/\s+/g, " ").trim();
	if (!normalized) return "本轮搜索";
	if (normalized.length <= MAX_QUERY_LABEL_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_QUERY_LABEL_LENGTH - 3)}...`;
}

function timestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

export function collectAgentResultDocuments(
	messages: AgentMessageView[],
	tools: AgentToolView[],
): AgentResultDocument[] {
	const orderedMessages = messages
		.map((message, index) => ({ message, index }))
		.sort((left, right) => timestamp(left.message.createdAt) - timestamp(right.message.createdAt) || left.index - right.index);
	const orderedTools = tools
		.map((tool, index) => ({ tool, index }))
		.filter(
			(entry) =>
				entry.tool.name === "update_literature_sidebar" &&
				entry.tool.status === "succeeded" &&
				Boolean(entry.tool.output),
		)
		.sort((left, right) => timestamp(left.tool.startedAt) - timestamp(right.tool.startedAt) || left.index - right.index);
	const seenUrls = new Set<string>();
	const documents: AgentResultDocument[] = [];

	for (const { tool } of orderedTools) {
		const result = parseAgentResultOutput(tool.output ?? "");
		if (!result.url || seenUrls.has(result.url)) continue;
		seenUrls.add(result.url);
		const toolTime = timestamp(tool.startedAt);
		const precedingMessages = orderedMessages.filter((entry) => timestamp(entry.message.createdAt) <= toolTime);
		const userMessage = [...precedingMessages].reverse().find((entry) => entry.message.role === "user")?.message;
		const userTime = userMessage ? timestamp(userMessage.createdAt) : 0;
		const nextUserTime = orderedMessages.find(
			(entry) => entry.message.role === "user" && timestamp(entry.message.createdAt) > toolTime,
		)?.message.createdAt;
		const precedingAnchor = [...precedingMessages]
			.reverse()
			.find(
				(entry) =>
					entry.message.role === "assistant" && timestamp(entry.message.createdAt) >= userTime,
			)?.message;
		const followingAnchor = orderedMessages.find(
			(entry) =>
				entry.message.role === "assistant" &&
				timestamp(entry.message.createdAt) > toolTime &&
				(!nextUserTime || timestamp(entry.message.createdAt) < timestamp(nextUserTime)),
		)?.message;
		const anchorMessage = precedingAnchor ?? followingAnchor;
		documents.push({
			id: tool.id,
			url: result.url,
			anchorMessageId: anchorMessage?.id,
			query: agentResultQueryLabel(userMessage?.content ?? ""),
			sequence: documents.length + 1,
			createdAt: tool.finishedAt ?? tool.startedAt,
			rowCount: result.rowCount,
		});
	}

	return documents;
}
