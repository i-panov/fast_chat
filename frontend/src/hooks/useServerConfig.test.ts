import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api.ts", () => ({
	getConfig: vi.fn(),
}));

const { getConfig } = await import("../api.ts");
const { useServerConfig } = await import("./useServerConfig.ts");

function mockGetConfig() {
	return vi.mocked(getConfig);
}

describe("useServerConfig", () => {
	it("returns null without a token and never fetches", () => {
		const { result } = renderHook(() => useServerConfig(null));

		expect(result.current.config).toBeNull();
		expect(mockGetConfig()).not.toHaveBeenCalled();
	});

	it("loads the config for a token", async () => {
		mockGetConfig().mockResolvedValueOnce({
			messageEditTTL: 60,
			messageDeleteTTL: 120,
		});

		const { result } = renderHook(() => useServerConfig("tok"));

		await waitFor(() => {
			expect(result.current.config).toEqual({
				messageEditTTL: 60,
				messageDeleteTTL: 120,
			});
		});
	});

	it("stays null when the fetch fails", async () => {
		mockGetConfig().mockRejectedValueOnce(new Error("down"));

		const { result } = renderHook(() => useServerConfig("tok"));

		await waitFor(() => {
			expect(mockGetConfig()).toHaveBeenCalled();
		});
		// Let the rejection settle; the hook swallows it.
		await waitFor(() => {
			expect(result.current.config).toBeNull();
		});
	});

	it("ignores a late response after the token is cleared", async () => {
		let resolve!: (cfg: {
			messageEditTTL: number;
			messageDeleteTTL: number;
		}) => void;
		mockGetConfig().mockReturnValueOnce(
			new Promise((res) => {
				resolve = res;
			}),
		);

		const initialProps: { token: string | null } = { token: "tok" };
		const { result, rerender } = renderHook(
			({ token }) => useServerConfig(token),
			{ initialProps },
		);

		rerender({ token: null });
		resolve({ messageEditTTL: 1, messageDeleteTTL: 2 });

		await waitFor(() => {
			expect(result.current.config).toBeNull();
		});
	});
});
