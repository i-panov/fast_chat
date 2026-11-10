import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessions, logoutAllSessions, revokeDeviceSession } from "./api.ts";

function jsonResponse(status: number, body: unknown) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: () => Promise.resolve(body),
		headers: { get: () => null },
	};
}

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("session API", () => {
	it("lists devices with the Bearer token", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { currentSessionId: "s1", sessions: [] }),
		);

		await getSessions("tok-123");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/sessions");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok-123",
		);
	});

	it("revokes a device session and signs out everywhere", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await revokeDeviceSession("tok", "s/2");
		await logoutAllSessions("tok");

		const [revokePath, revokeInit] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(revokePath).toBe("/api/sessions/s%2F2");
		expect(revokeInit.method).toBe("DELETE");

		const [allPath, allInit] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(allPath).toBe("/api/auth/logout-all");
		expect(allInit.method).toBe("POST");
	});
});
