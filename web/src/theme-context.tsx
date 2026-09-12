import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
	theme: ThemeMode;
	resolvedTheme: ResolvedTheme;
	setTheme: (mode: ThemeMode) => void;
	toggleTheme: () => void;
}

const STORAGE_KEY = "paper-agent-theme-preference";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
	if (typeof window === "undefined" || !window.matchMedia) return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<ThemeMode>(() => {
		if (typeof window === "undefined") return "system";
		const saved = window.localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
		return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
	});

	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? "dark" : "light");
		mediaQuery.addEventListener("change", handler);
		return () => mediaQuery.removeEventListener("change", handler);
	}, []);

	const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

	useEffect(() => {
		const root = document.documentElement;
		root.classList.add("theme-transition");
		root.setAttribute("data-theme", resolvedTheme);
		root.style.colorScheme = resolvedTheme;
		const timer = window.setTimeout(() => root.classList.remove("theme-transition"), 250);
		return () => window.clearTimeout(timer);
	}, [resolvedTheme]);

	const setTheme = (mode: ThemeMode) => {
		setThemeState(mode);
		window.localStorage.setItem(STORAGE_KEY, mode);
	};

	const toggleTheme = () => {
		setTheme(resolvedTheme === "dark" ? "light" : "dark");
	};

	return (
		<ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return ctx;
}
