export const AGENT_SCROLL_BOTTOM_THRESHOLD = 96;

export interface ScrollMetrics {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export function isAgentTranscriptNearBottom(
	metrics: ScrollMetrics,
	threshold = AGENT_SCROLL_BOTTOM_THRESHOLD,
): boolean {
	return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
