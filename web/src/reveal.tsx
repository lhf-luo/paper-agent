import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Scroll-reveal utility: elements tagged with `data-reveal` start hidden
 * (see motion.css) and transition in when they enter the viewport.
 * Honors prefers-reduced-motion purely in CSS; if IntersectionObserver is
 * unavailable the element is revealed immediately.
 */

const hasDOM = typeof window !== "undefined";

let sharedObserver: IntersectionObserver | undefined;

function getObserver(): IntersectionObserver | undefined {
	if (!hasDOM || !("IntersectionObserver" in window)) return undefined;
	if (!sharedObserver) {
		sharedObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						entry.target.classList.add("is-revealed");
						sharedObserver?.unobserve(entry.target);
					}
				}
			},
			{ threshold: 0.1, rootMargin: "0px 0px -4% 0px" },
		);
	}
	return sharedObserver;
}

export function observeReveal(element: HTMLElement | null): () => void {
	if (!element) return () => {};
	const observer = getObserver();
	if (!observer) {
		element.classList.add("is-revealed");
		return () => {};
	}
	observer.observe(element);
	return () => observer.unobserve(element);
}

/** Attach to any element to make it reveal on first viewport entry. */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
	const ref = useRef<T | null>(null);
	useEffect(() => observeReveal(ref.current), []);
	return ref;
}

interface RevealProps {
	children: ReactNode;
	className?: string;
	/** Stagger delay in milliseconds before the entrance transition starts. */
	delay?: number;
	style?: CSSProperties;
	/** Render as a semantic element instead of div. */
	as?: "div" | "section" | "header" | "article" | "aside" | "li" | "span";
}

export function Reveal({ children, className, delay = 0, style, as: Tag = "div" }: RevealProps) {
	const ref = useReveal<HTMLDivElement>();
	const mergedStyle: CSSProperties = {
		...style,
		...(delay > 0 ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties) : {}),
	};
	return (
		<Tag ref={ref as never} data-reveal className={className} style={mergedStyle}>
			{children}
		</Tag>
	);
}
