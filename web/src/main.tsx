// pdfjs-dist 使用了较新的 Map#getOrInsertComputed(ES2025, Chrome 123+/Safari 17.4+)。
// 在不支持的环境里先打补丁, 避免 "getOrInsertComputed is not a function"。
type ExtendedMap = Map<unknown, unknown> & {
	getOrInsertComputed?(
		key: unknown,
		callback: (key: unknown, map: Map<unknown, unknown>) => unknown,
	): unknown;
	getOrInsert?(key: unknown, value: unknown): unknown;
};

const mapProto = Map.prototype as ExtendedMap;

if (typeof mapProto.getOrInsertComputed !== "function") {
	mapProto.getOrInsertComputed = function getOrInsertComputed(key, callback) {
		if (!this.has(key)) {
			this.set(key, callback(key, this));
		}
		return this.get(key);
	};
}
if (typeof mapProto.getOrInsert !== "function") {
	mapProto.getOrInsert = function getOrInsert(key, value) {
		if (!this.has(key)) {
			this.set(key, value);
		}
		return this.get(key);
	};
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
