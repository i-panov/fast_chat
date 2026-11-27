import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearFileCache } from "../utils/fileCache.ts";
import { useFileUrl } from "./useFileUrl.ts";

let urlCounter = 0;

beforeEach(() => {
	clearFileCache();
	urlCounter = 0;
	URL.createObjectURL = vi.fn(() => `blob:mock-${urlCounter++}`);
	URL.revokeObjectURL = vi.fn();
});

describe("useFileUrl", () => {
	it("returns nulls without a URL", () => {
		const { result } = renderHook(() => useFileUrl(undefined, "tok"));

		expect(result.current).toEqual({
			blobUrl: null,
			loading: false,
			error: null,
		});
	});

	it("does not hand the previous file to the new source", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(new Blob(["data"])))),
		);

		const { result, rerender } = renderHook(
			({ url }: { url: string }) => useFileUrl(url, "tok"),
			{ initialProps: { url: "https://srv/f/1" } },
		);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock-0");
		});

		rerender({ url: "https://srv/f/2" });

		// The first render after the switch belongs to the new file: the old
		// URL has already been released and must not be shown.
		expect(result.current.blobUrl).toBeNull();
		expect(result.current.loading).toBe(true);

		vi.unstubAllGlobals();
	});

	it("acquires the blob URL", async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve(new Response(new Blob(["data"]))),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useFileUrl("https://srv/f/1", "tok"));

		expect(result.current.loading).toBe(true);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock-0");
		});
		expect(result.current).toEqual({
			blobUrl: "blob:mock-0",
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
