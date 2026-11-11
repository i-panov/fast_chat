import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshToken } from "./api.ts";
import {
	onUnauthorized,
	registerTokenReplacement,
} from "./utils/authEvents.ts";

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

describe("rotated token retry", () => {
	it("retries once with the token another tab rotated to", async () => {
		const unauthSpy = vi.fn();
		const off = onUnauthorized(unauthSpy);
		registerTokenReplacement("rotated-old", "rotated-new");
		fetchMock
			.mockResolvedValueOnce(jsonResponse(401, { error: "expired" }))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

		await expect(refreshToken("rotated-old")).resolves.toEqual({ ok: true });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect((secondInit.headers as Record<string, string>).Authorization).toBe(
			"Bearer rotated-new",
		);
		expect(unauthSpy).not.toHaveBeenCalled();
		off();
	});
});
