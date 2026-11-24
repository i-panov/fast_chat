/**
 * Routing decisions of the Service Worker.
 *
 * The decisions live outside `sw.ts` because that file is not part of the
 * unit test run (it needs the globals of a worker), while these predicates
 * are plain functions and must stay covered by tests.
 */

/** The handler that owns a request. */
export type RouteKind = "api" | "precache" | "navigation" | "none";

export interface RequestFacts {
	url: string;
	method: string;
	mode: string;
	sameOrigin: boolean;
}

/**
 * classifyRequest decides which handler owns a request.
 *
 * Cross-origin requests belong to no handler. A request routed through the
 * worker is subject to the CSP of the worker script (loaded with the
 * document policy), not to the policy of the page: the map tiles are allowed
 * by `img-src`, but the worker's `connect-src` refused them, and the maps
 * stayed empty. Leaving them to the browser restores the page policy.
 */
export function classifyRequest(
	request: RequestFacts,
	precached: readonly string[],
): RouteKind {
	if (!request.sameOrigin) {
		return "none";
	}

	if (new URL(request.url).pathname.startsWith("/api/")) {
		return "api";
	}

	if (request.method !== "GET") {
		return "none";
	}

	if (precached.includes(request.url)) {
		return "precache";
	}

	return request.mode === "navigate" ? "navigation" : "none";
}
