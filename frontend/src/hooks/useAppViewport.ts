import { useLayoutEffect } from "react";

const APP_HEIGHT_VAR = "--app-height";

// visualViewport is the only reliable source of the visible phone screen:
// layout viewport and 100dvh ignore the browser toolbars and, on iOS, the
// on-screen keyboard. Pinch-zoom also shrinks visualViewport, so the app is
// not resized while the user zooms.
function visibleHeight(): number | null {
	const viewport = window.visualViewport;
	if (viewport === undefined || viewport === null) {
		return Math.round(window.innerHeight);
	}
	if (Math.abs((viewport.scale ?? 1) - 1) > 0.01) return null;
	return Math.round(viewport.height);
}

// useAppViewport keeps --app-height equal to the visible screen. Layouts that
// must stay inside the phone viewport (the chat column and its composer) use
// the variable instead of 100dvh.
export function useAppViewport(): void {
	useLayoutEffect(() => {
		let frame: number | null = null;
		let applied = 0;

		const apply = () => {
			frame = null;
			const height = visibleHeight();
			if (height === null || height <= 0 || height === applied) return;
			applied = height;
			document.documentElement.style.setProperty(APP_HEIGHT_VAR, `${height}px`);
		};
		const schedule = () => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(apply);
		};

		apply();
		const viewport = window.visualViewport;
		viewport?.addEventListener("resize", schedule);
		viewport?.addEventListener("scroll", schedule);
		window.addEventListener("resize", schedule);
		window.addEventListener("orientationchange", schedule);

		return () => {
			if (frame !== null) window.cancelAnimationFrame(frame);
			viewport?.removeEventListener("resize", schedule);
			viewport?.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			window.removeEventListener("orientationchange", schedule);
			document.documentElement.style.removeProperty(APP_HEIGHT_VAR);
		};
	}, []);
}
