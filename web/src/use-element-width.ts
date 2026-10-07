import { useEffect, useRef, useState } from "react";

export function useElementWidth<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(() => window.innerWidth);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => setWidth(element.getBoundingClientRect().width);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return { ref, width };
}
