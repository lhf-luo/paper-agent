import { resolve } from "node:path";
import { loadPaperAgentConfig } from "../../config/application/config-service.ts";
import {
	type ConfirmationGrant,
	type OperationAuthorization,
	OperationConsentManager,
	type OperationPlan,
	type PreparedOperation,
} from "../../shared/application/operation-consent.ts";
import { requiresOperationConfirmation } from "../../shared/domain/operation-confirmation.ts";

export interface InteractiveOperationPrompt {
	title: string;
	unavailableMessage: string;
	details?: (prepared: PreparedOperation) => string[];
}

export interface AgentOperationContext {
	cwd: string;
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

export async function authorizePreparedAgentOperation(
	ctx: AgentOperationContext,
	manager: OperationConsentManager,
	prepared: PreparedOperation,
	prompt: InteractiveOperationPrompt,
): Promise<ConfirmationGrant> {
	const config = await loadPaperAgentConfig(ctx.cwd);
	if (!requiresOperationConfirmation(prepared.kind, "agent", config.confirmations)) {
		return manager.confirm(prepared.operationId, prepared.manifestFingerprint, "local-confirmation-policy");
	}
	if (!ctx.hasUI) throw new Error(prompt.unavailableMessage);
	const accepted = await ctx.ui.confirm(
		prompt.title,
		[
			prepared.summary,
			`Manifest: ${prepared.manifestFingerprint}`,
			...prepared.targets.map((target) => `- [${target.risk ?? "medium"}] ${target.label}: ${target.value}`),
			...(prompt.details?.(prepared) ?? []),
		].join("\n"),
	);
	if (!accepted) {
		await manager.cancel(prepared.operationId, "interactive-user");
		throw new Error("Operation was cancelled by the user");
	}
	return manager.confirm(prepared.operationId, prepared.manifestFingerprint, "interactive-user");
}

export async function requestInteractiveOperationAuthorization(
	ctx: AgentOperationContext,
	plan: OperationPlan,
	prompt: InteractiveOperationPrompt,
): Promise<OperationAuthorization> {
	const manager = new OperationConsentManager({
		auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
		signingKeyPath: resolve(ctx.cwd, ".paper-agent", "runtime", "operation-signing.key"),
	});
	const prepared = await manager.prepare(plan);
	return { manager, grant: await authorizePreparedAgentOperation(ctx, manager, prepared, prompt) };
}
