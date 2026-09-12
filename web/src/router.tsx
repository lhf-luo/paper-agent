import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Page } from "./types";

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

function parseUrl(): RouteState {
	if (typeof window === "undefined") {
		return { page: "dashboard", params: {} };
	}
	const search = new URLSearchParams(window.location.search);
	const rawPage = search.get("page") as Page | null;
	const validPages: Page[] = [
		"dashboard",
		"search",
		"agent",
		"library",
		"tasks",
		"pdf",
		"team",
		"research",
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
			setRoute(parseUrl());
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	const navigate = useCallback((nextPage: Page, nextParams: Record<string, string> = {}, replace = false) => {
		const search = new URLSearchParams();
		search.set("page", nextPage);
		for (const [k, v] of Object.entries(nextParams)) {
			if (v) search.set(k, v);
		}
		const newSearch = search.toString();
		const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ""}${window.location.hash}`;

		if (replace) {
			window.history.replaceState({ page: nextPage, params: nextParams }, "", newUrl);
		} else {
			window.history.pushState({ page: nextPage, params: nextParams }, "", newUrl);
		}
		setRoute({ page: nextPage, params: nextParams });
	}, []);

	const updateParams = useCallback((paramsToUpdate: Record<string, string | null | undefined>) => {
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
		});
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
