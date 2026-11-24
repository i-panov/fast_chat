import { describe, expect, it, vi } from "vitest";
import { handleNavigation } from "./navigation";

function fakeCache(entries: Record<string, Response>) {
	const put = vi.fn((request: Request, response: Response) => {
		entries[request.url] = response;

		return Promise.resolve();
	});
	const match = vi.fn((request: string | Request) => {
		const url = typeof request === "string" ? request : request.url;

		return Promise.resolve(entries[url]);
	});

	return { cache: { put, match } as unknown as Cache, put };
}

const SHELL = "https://chat.example/index.html";

// jsdom constructs responses with type "default"; the worker only caches
// basic (same-origin) responses.
function basicResponse(body: string): Response {
	const response = new Response(body, { status: 200 });
	Object.defineProperty(response, "type", { value: "basic" });

	return response;
}

describe("handleNavigation", () => {
	it("returns the network response and caches it", async () => {
		const { cache, put } = fakeCache({});
		const request = new Request("https://chat.example/chat");
		const response = basicResponse("<html>fresh</html>");
		const fetchImpl = vi.fn(() => Promise.resolve(response));

		const result = await handleNavigation({
			request,
			shellURL: SHELL,
			cache,
			fetchImpl: fetchImpl,
		});

		expect(result).toBe(response);
		expect(put).toHaveBeenCalledOnce();
	});

	it("serves the cached page when the network is down", async () => {
		const cached = new Response("<html>cached chat</html>");
		const { cache } = fakeCache({ "https://chat.example/chat": cached });
		const request = new Request("https://chat.example/chat");
		const fetchImpl = vi.fn(() => {
			throw new Error("offline");
		});

		const result = await handleNavigation({
			request,
			shellURL: SHELL,
			cache,
			fetchImpl: fetchImpl,
		});

		expect(result).toBe(cached);
	});

	it("falls back to the cached shell for a route never visited", async () => {
		const shell = new Response("<html>app shell</html>");
		const { cache } = fakeCache({ [SHELL]: shell });
		const request = new Request("https://chat.example/admin");
		const fetchImpl = vi.fn(() => {
			throw new Error("offline");
		});

		const result = await handleNavigation({
			request,
			shellURL: SHELL,
			cache,
			fetchImpl: fetchImpl,
		});

		expect(result).toBe(shell);
	});

	it("rethrows when neither the page nor the shell is cached", async () => {
		const { cache } = fakeCache({});
		const request = new Request("https://chat.example/chat");
		const fetchImpl = vi.fn(() => {
			throw new Error("offline");
		});

		await expect(
			handleNavigation({
				request,
				shellURL: SHELL,
				cache,
				fetchImpl: fetchImpl,
			}),
		).rejects.toThrow("offline");
	});
});
