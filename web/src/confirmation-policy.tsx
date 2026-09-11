import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { requiresWebOperationConfirmation } from "./confirmation-policy-rules";
import type { OperationConfirmationSettingsView, PreparedOperation } from "./types";

export { requiresWebOperationConfirmation } from "./confirmation-policy-rules";

const safeDefaults: OperationConfirmationSettingsView = {
	requireAgentWriteConfirmation: true,
	requirePersonalLibraryWriteConfirmation: true,
	requirePersonalLibraryDeleteConfirmation: true,
	requireResearchConfirmation: true,
	requirePdfArtifactConfirmation: true,
	requireWikiWriteConfirmation: true,
};

const ConfirmationPolicyContext = createContext<OperationConfirmationSettingsView>(safeDefaults);

export function ConfirmationPolicyProvider({
	settings,
	children,
}: {
	settings?: OperationConfirmationSettingsView;
	children: ReactNode;
}) {
	return (
		<ConfirmationPolicyContext.Provider value={settings ?? safeDefaults}>
			{children}
		</ConfirmationPolicyContext.Provider>
	);
}

export function useConfirmationPolicy(): OperationConfirmationSettingsView {
	return useContext(ConfirmationPolicyContext);
}

export function useAutomaticOperationConfirmation(
	operation: PreparedOperation | undefined,
	busy: boolean,
	onConfirm: () => void | Promise<void>,
): { confirmationRequired: boolean; automaticAttemptFailed: boolean } {
	const settings = useConfirmationPolicy();
	const confirmationRequired = operation ? requiresWebOperationConfirmation(operation.kind, settings) : true;
	const attemptedOperation = useRef<string | undefined>(undefined);
	const currentOperation = useRef(operation?.operationId);
	const confirmRef = useRef(onConfirm);
	const [automaticAttemptFailed, setAutomaticAttemptFailed] = useState(false);
	currentOperation.current = operation?.operationId;
	confirmRef.current = onConfirm;

	useEffect(() => {
		if (!operation || confirmationRequired || busy || attemptedOperation.current === operation.operationId) return;
		const operationId = operation.operationId;
		attemptedOperation.current = operationId;
		setAutomaticAttemptFailed(false);
		Promise.resolve(confirmRef.current()).finally(() => {
			window.setTimeout(() => {
				if (currentOperation.current === operationId) setAutomaticAttemptFailed(true);
			}, 100);
		});
	}, [busy, confirmationRequired, operation]);

	useEffect(() => {
		if (attemptedOperation.current !== operation?.operationId) setAutomaticAttemptFailed(false);
	}, [operation?.operationId]);

	return { confirmationRequired, automaticAttemptFailed };
}
