import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import type { Page } from "./types.ts";

export interface RouteState {
	page: Page;
	params: Record<string, string>;
}

export interface RouterContextValue {
	page: Page;
	params: Record<string, string>;
	navigate: (nextPage: Page, nextParams?: Record<string, string>, replace?: boolean) => void;
	updateParams: (paramsToUpdate: Record<string, string | null | undefined>) => void;
}

const RouterContext = createContext<RouterContextValue | null>(null);

function requestRouteChange(proceed: () => void): void {
	const event = new CustomEvent("paper-agent:before-route", { cancelable: true, detail: { proceed } });
	if (window.dispatchEvent(event)) proceed();
}

export function parseUrl(): RouteState {
	if (typeof window === "undefined") {
		return { page: "dashboard", params: {} };
	}
	const search = new URLSearchParams(window.location.search);
	const rawPage = search.get("page") as Page | null;
	const validPages: Page[] = [
		"dashboard",
		"search",
		"news",
		"agent",
		"library",
		"tasks",
		"pdf",
		"team",
		"research",
		"quick-notes",
		"canvas",
		"wiki",
		"settings",
		"reader",
	];
	const page: Page = rawPage && validPages.includes(rawPage) ? rawPage : "dashboard";
	const params: Record<string, string> = {};
	search.forEach((value, key) => {
		if (key !== "page") {
			params[key] = value;
		}
	});
	return { page, params };
}

export function useRouter(initialDefaultPage: Page = "dashboard"): RouterContextValue {
	const [route, setRoute] = useState<RouteState>(() => {
		const parsed = parseUrl();
		const hasExplicitPage = new URLSearchParams(window.location.search).has("page");
		if (!hasExplicitPage && initialDefaultPage !== "dashboard") {
			return { page: initialDefaultPage, params: parsed.params };
		}
		return parsed;
	});

	useEffect(() => {
		const handlePopState = () => {
			const target = parseUrl();
			const targetUrl = window.location.href;
			const event = new CustomEvent("paper-agent:before-route", {
				cancelable: true,
				detail: {
					proceed: () => {
						window.history.replaceState(target, "", targetUrl);
						setRoute(target);
					},
				},
			});
			if (!window.dispatchEvent(event)) {
				const search = new URLSearchParams({ page: route.page });
				for (const [key, value] of Object.entries(route.params)) if (value) search.set(key, value);
				window.history.pushState(
					route,
					"",
					`${window.location.pathname}?${search.toString()}${window.location.hash}`,
				);
				return;
			}
			setRoute(target);
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, [route]);

	const navigate = useCallback((nextPage: Page, nextParams: Record<string, string> = {}, replace = false) => {
		const search = new URLSearchParams();
		search.set("page", nextPage);
		for (const [k, v] of Object.entries(nextParams)) {
			if (v) search.set(k, v);
		}
		const newSearch = search.toString();
		const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ""}${window.location.hash}`;

		requestRouteChange(() => {
			if (replace) {
				window.history.replaceState({ page: nextPage, params: nextParams }, "", newUrl);
			} else {
				window.history.pushState({ page: nextPage, params: nextParams }, "", newUrl);
			}
			setRoute({ page: nextPage, params: nextParams });
		});
	}, []);

	const updateParams = useCallback((paramsToUpdate: Record<string, string | null | undefined>) => {
		requestRouteChange(() =>
			setRoute((current) => {
				const updated = { ...current.params };
				for (const [k, v] of Object.entries(paramsToUpdate)) {
					if (v === null || v === undefined || v === "") {
						delete updated[k];
					} else {
						updated[k] = v;
					}
				}
				const search = new URLSearchParams();
				search.set("page", current.page);
				for (const [k, v] of Object.entries(updated)) {
					if (v) search.set(k, v);
				}
				const newUrl = `${window.location.pathname}?${search.toString()}${window.location.hash}`;
				window.history.replaceState({ page: current.page, params: updated }, "", newUrl);
				return { page: current.page, params: updated };
			}),
		);
	}, []);

	return {
		page: route.page,
		params: route.params,
		navigate,
		updateParams,
	};
}

export function RouterProvider({ children, value }: { children: ReactNode; value: RouterContextValue }) {
	return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouterContext(): RouterContextValue {
	const ctx = useContext(RouterContext);
	if (!ctx) {
		throw new Error("useRouterContext must be used within a RouterProvider");
	}
	return ctx;
}
