import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type OperationAuthorization,
	OperationConsentManager,
	type OperationPlan,
	type PreparedOperation,
	requestOperationAuthorization,
} from "./operation-consent.ts";

export interface InteractiveOperationPrompt {
	title: string;
	unavailableMessage: string;
	details?: (prepared: PreparedOperation) => string[];
}

export async function requestInteractiveOperationAuthorization(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">,
	plan: OperationPlan,
	prompt: InteractiveOperationPrompt,
): Promise<OperationAuthorization> {
	if (!ctx.hasUI) throw new Error(prompt.unavailableMessage);
	const manager = new OperationConsentManager({
		auditPath: resolve(ctx.cwd, ".paper-agent", "audit", "operations.jsonl"),
	});
	return requestOperationAuthorization(
		manager,
		plan,
		(prepared) =>
			ctx.ui.confirm(
				prompt.title,
				[
					prepared.summary,
					`Manifest: ${prepared.manifestFingerprint}`,
					...prepared.targets.map((target) => `- [${target.risk ?? "medium"}] ${target.label}: ${target.value}`),
					...(prompt.details?.(prepared) ?? []),
				].join("\n"),
			),
		"interactive-user",
	);
}
