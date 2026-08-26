import { describe, expect, it } from "vitest";
import { compareByCreatedAt } from "./ordering.ts";

describe("compareByCreatedAt", () => {
	it("keeps a newer client-format timestamp after an older server one in the same second", () => {
		// Server (Go RFC3339Nano, trailing zeros trimmed) at 900ms.
		const serverOlder = "2026-08-26T14:45:09.9Z";
		// Client (toISOString) at 973ms — numerically newer.
		const clientNewer = "2026-08-26T14:45:09.973Z";

		// The old lexicographic comparison put .9Z AFTER .973Z ('Z' > '7'),
		// so the newer message appeared above the older one.
		expect(compareByCreatedAt(serverOlder, clientNewer, "a", "b")).toBeLessThan(
			0,
		);
		expect(
			compareByCreatedAt(clientNewer, serverOlder, "b", "a"),
		).toBeGreaterThan(0);
	});

	it("treats an exact-second server timestamp as older than a client one in the same second", () => {
		// Lexicographically "2026-08-26T14:45:09Z" > "2026-08-26T14:45:09.500Z"
		// ('Z' > '.'), which inverted the order.
		const serverExact = "2026-08-26T14:45:09Z";
		const client = "2026-08-26T14:45:09.500Z";

		expect(compareByCreatedAt(serverExact, client, "a", "b")).toBeLessThan(0);
		expect(compareByCreatedAt(client, serverExact, "b", "a")).toBeGreaterThan(
			0,
		);
	});

	it("orders across different seconds numerically", () => {
		const older = "2026-08-26T14:44:59Z";
		const newer = "2026-08-26T14:45:01.123Z";

		expect(compareByCreatedAt(older, newer, "a", "b")).toBeLessThan(0);
		expect(compareByCreatedAt(newer, older, "b", "a")).toBeGreaterThan(0);
	});

	it("tie-breaks by id when timestamps are equal", () => {
		const a = "2026-08-26T14:45:09.5Z";
		const b = "2026-08-26T14:45:09.5Z";

		expect(compareByCreatedAt(a, b, "msg-a", "msg-b")).toBeLessThan(0);
		expect(compareByCreatedAt(a, b, "msg-b", "msg-a")).toBeGreaterThan(0);
		expect(compareByCreatedAt(a, b, "msg-a", "msg-a")).toBe(0);
	});

	it("falls back to string comparison for invalid timestamps", () => {
		expect(
			compareByCreatedAt("not-a-date", "2026-08-26T14:45:09Z", "a", "b"),
		).not.toBe(0);
	});
});
