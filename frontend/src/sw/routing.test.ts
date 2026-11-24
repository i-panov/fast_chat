import { describe, expect, it } from "vitest";
import { classifyRequest, type RequestFacts } from "./routing";

const ORIGIN = "https://chat.example";

const facts = (
	path: string,
	overrides: Partial<RequestFacts> = {},
): RequestFacts => ({
	url: `${ORIGIN}${path}`,
	method: "GET",
	mode: "no-cors",
	sameOrigin: true,
	...overrides,
});

const PRECACHED = [`${ORIGIN}/index.html`, `${ORIGIN}/assets/app-123.js`];

describe("classifyRequest", () => {
	it("sends API calls to the network handler", () => {
		expect(classifyRequest(facts("/api/config"), PRECACHED)).toBe("api");
		expect(
			classifyRequest(facts("/api/messages", { method: "POST" }), PRECACHED),
		).toBe("api");
	});

	it("serves precached assets from the cache", () => {
		expect(classifyRequest(facts("/assets/app-123.js"), PRECACHED)).toBe(
			"precache",
		);
	});

	it("falls back to the shell for same-origin navigations", () => {
		expect(
			classifyRequest(facts("/chat", { mode: "navigate" }), PRECACHED),
		).toBe("navigation");
	});

	it("does not intercept cross-origin requests such as map tiles", () => {
		expect(
			classifyRequest(
				{
					url: "https://a.tile.openstreetmap.org/10/512/340.png",
					method: "GET",
					mode: "no-cors",
					sameOrigin: false,
				},
				PRECACHED,
			),
		).toBe("none");
	});

	it("does not intercept other same-origin requests", () => {
		expect(classifyRequest(facts("/logo192.png"), PRECACHED)).toBe("none");
	});
});
