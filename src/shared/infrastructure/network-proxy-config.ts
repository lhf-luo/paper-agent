import { ProxyAgent } from "undici";

let configuredProxy: URL | undefined;
let proxyAgent: ProxyAgent | undefined;
let bypassProxyHosts: string[] = [];

export function setProxyBypassHosts(hosts: string[]): void {
	bypassProxyHosts = (hosts ?? [])
		.map((host) =>
			host
				.trim()
				.toLowerCase()
				.replace(/^https?:\/\//, "")
				.replace(/\/.*$/, ""),
		)
		.filter(Boolean);
}

export function shouldBypassProxy(target: URL): boolean {
	const host = target.hostname.toLowerCase();
	return bypassProxyHosts.some((entry) => host === entry || host.endsWith(`.${entry}`) || host.endsWith(entry));
}

export function setProxyUrl(value: string | undefined): void {
	if (!value) {
		configuredProxy = undefined;
		proxyAgent = undefined;
		return;
	}
	const parsed = new URL(value);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Proxy URL must use http:// or https://");
	}
	configuredProxy = parsed;
	proxyAgent = undefined;
}

export function getConfiguredProxy(): URL | undefined {
	return configuredProxy;
}

export function getProxyAgent(): ProxyAgent | undefined {
	if (!configuredProxy) return undefined;
	proxyAgent ??= new ProxyAgent(configuredProxy.href);
	return proxyAgent;
}
