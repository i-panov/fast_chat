import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileUrl } from "./useFileUrl.ts";

beforeEach(() => {
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
});

describe("useFileUrl", () => {
	it("returns nulls without a URL", () => {
		const { result } = renderHook(() => useFileUrl(undefined, "tok"));

		expect(result.current).toEqual({
			blobUrl: null,
			loading: true,
			error: null,
		});
	});

	it("acquires the blob URL", async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve(new Response(new Blob(["data"]))),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useFileUrl("https://srv/f/1", "tok"));

		expect(result.current.loading).toBe(true);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});
		expect(result.current).toEqual({
			blobUrl: "blob:mock",
			loading: false,
			error: null,
		});
		expect(fetchMock).toHaveBeenCalledWith("https://srv/f/1", {
			headers: { Authorization: "Bearer tok" },
		});
		vi.unstubAllGlobals();
	});

	it("surfaces load errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("down"))),
		);

		const { result } = renderHook(() => useFileUrl("https://srv/f/1", "tok"));

		await waitFor(() => {
			expect(result.current.error).toBeTruthy();
		});
		expect(result.current.loading).toBe(false);
		vi.unstubAllGlobals();
	});
});
