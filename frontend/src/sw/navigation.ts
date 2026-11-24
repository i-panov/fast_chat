/**
 * Navigation handling of the Service Worker, kept outside `sw.ts` so the
 * offline path is testable without worker globals.
 *
 * A navigation goes to the network first so a new deployment is picked up;
 * offline it is answered from the per-request cache, then from the cached
 * shell, which is one document for every client-side route.
 */
export interface NavigationOptions {
	request: Request;
	shellURL: string;
	cache: Cache;
	fetchImpl?: typeof fetch;
}

export async function handleNavigation({
	request,
	shellURL,
	cache,
	fetchImpl,
}: NavigationOptions): Promise<Response> {
	const network = fetchImpl ?? fetch;

	try {
		const response = await network(request);
		// Only a real same-origin response is cached: opaque and CORS
		// responses must not be stored under the same-origin URL.
		if (response.ok && response.type === "basic") {
			await cache.put(request, response.clone());
		}

		return response;
	} catch (error) {
		const cached = await cache.match(request);
		if (cached !== undefined) {
			return cached;
		}

		const shell = await cache.match(shellURL);
		if (shell !== undefined) {
			return shell;
		}

		throw error;
	}
}
