export type WebAgentDelivery = "steer" | "followUp";

export interface WebAgentPendingInput {
	id: string;
	delivery: WebAgentDelivery;
	content: string;
	attachmentNames?: string[];
	createdAt: string;
	status: "queued" | "paused" | "uncertain";
}

export interface StoredWebAgentInput extends WebAgentPendingInput {
	prompt: string;
	phase: "prepared" | "dispatching" | "queued" | "delivering" | "paused" | "uncertain";
	nativeText?: string;
	deliveredAt?: string;
}

export interface WebAgentInputState {
	recovered?: StoredWebAgentInput[];
	pending: StoredWebAgentInput[];
	receipts: Record<string, string>;
	paused: boolean;
}

export function emptyWebAgentInputs(): WebAgentInputState {
	return { pending: [], receipts: {}, paused: false };
}
