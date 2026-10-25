export interface CanvasGraphState {
	revision: number;
	layoutVersion?: string;
	needsFit?: boolean;
	manualPins?: string[];
	previousLayout?: {
		positions: Record<string, { x: number; y: number }>;
		viewport: { x: number; y: number; scale: number };
		layoutVersion?: string;
		manualPins?: string[];
	};
	positions: Record<string, { x: number; y: number }>;
	viewport: { x: number; y: number; scale: number };
	focusId?: string;
	filters?: { query: string; year: string; batch: string; status: string };
}
export { paperIdentityKeys, samePaper } from "../../literature/domain/reliable-paper-identity.ts";
