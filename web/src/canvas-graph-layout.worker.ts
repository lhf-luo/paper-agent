import { staticGraphLayout, type LayoutInput } from "./canvas-graph-layout";
self.onmessage = (event: MessageEvent<LayoutInput>) => {
	try {
		self.postMessage({ positions: staticGraphLayout(event.data) });
	} catch (error) {
		self.postMessage({ error: String(error) });
	}
};
