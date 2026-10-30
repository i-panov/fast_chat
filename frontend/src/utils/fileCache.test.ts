import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileCacheRepo } from "../db/fileCacheRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import {
	acquireFileBlobUrl,
	clearFileCache,
	releaseFileBlobUrl,
} from "./fileCache.ts";

let urlCounter = 0;

function okResponse(body: string) {
	return new Response(new Blob([body], { type: "text/plain" }));
}

beforeEach(() => {
	urlCounter = 0;
	URL.createObjectURL = vi.fn(() => `blob:mock-${urlCounter++}`);
	URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
	clearFileCache();
	vi.unstubAllGlobals();
});

describe("fileCache", () => {
	it("returns blob: URLs as-is without fetching", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(okResponse("x")));
		vi.stubGlobal("fetch", fetchMock);

		await expect(acquireFileBlobUrl("blob:local")).resolves.toBe("blob:local");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches with an auth header and caches in IDB", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(okResponse("data")));
		vi.stubGlobal("fetch", fetchMock);

		const url = await acquireFileBlobUrl("https://srv/f/1", "tok");

		expect(url).toBe("blob:mock-0");
		expect(fetchMock).toHaveBeenCalledWith("https://srv/f/1", {
			headers: { Authorization: "Bearer tok" },
		});

		await vi.waitFor(async () => {
			expect(await fileCacheRepo.get("https://srv/f/1")).not.toBeUndefined();
		});

		releaseFileBlobUrl("https://srv/f/1");
	});

	it("shares one fetch between concurrent acquirers", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(okResponse("data")));
		vi.stubGlobal("fetch", fetchMock);

		const [a, b] = await Promise.all([
			acquireFileBlobUrl("https://srv/f/2"),
			acquireFileBlobUrl("https://srv/f/2"),
		]);

		expect(a).toBe(b);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		releaseFileBlobUrl("https://srv/f/2");
		releaseFileBlobUrl("https://srv/f/2");
	});

	it("refetches after the last release", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(okResponse("d")));
		vi.stubGlobal("fetch", fetchMock);

		await acquireFileBlobUrl("https://srv/f/3");
		await vi.waitFor(async () => {
			expect(await fileCacheRepo.get("https://srv/f/3")).not.toBeUndefined();
		});
		releaseFileBlobUrl("https://srv/f/3");

		// Drop the IDB copy so the second acquire must hit the network.
		await fileCacheRepo.remove("https://srv/f/3");

		await expect(acquireFileBlobUrl("https://srv/f/3")).resolves.toBe(
			"blob:mock-1",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		releaseFileBlobUrl("https://srv/f/3");
	});

	it("serves a repeated acquire from IDB without fetching", async () => {
		await fileCacheRepo.put(
			"https://srv/f/4",
			new Blob(["cached"], { type: "text/plain" }),
			"text/plain",
		);
		const fetchMock = vi.fn(() => Promise.resolve(okResponse("net")));
		vi.stubGlobal("fetch", fetchMock);

		const url = await acquireFileBlobUrl("https://srv/f/4");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(url).toBe("blob:mock-0");

		releaseFileBlobUrl("https://srv/f/4");
	});

	it("isolates the in-memory cache per account", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(okResponse("data")));
		vi.stubGlobal("fetch", fetchMock);

		setActiveAccountKey("alice");
		const a = await acquireFileBlobUrl("https://srv/f/acct", "tok-a");
		setActiveAccountKey("bob");
		const b = await acquireFileBlobUrl("https://srv/f/acct", "tok-b");

		// Same URL, different accounts: two network fetches, different blobs.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(a).not.toBe(b);

		releaseFileBlobUrl("https://srv/f/acct");
		setActiveAccountKey("alice");
		releaseFileBlobUrl("https://srv/f/acct");
		setActiveAccountKey(null);
	});

	it("a failed load poisons the entry until release, then retries", async () => {
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(new Response(new Blob(["e"]), { status: 500 }))
			.mockResolvedValueOnce(okResponse("ok"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(acquireFileBlobUrl("https://srv/f/5")).rejects.toThrow(
			"Failed to load file: 500",
		);
		// The rejected promise is cached: release drops it so the next
		// acquire fetches again.
		releaseFileBlobUrl("https://srv/f/5");
		await fileCacheRepo.remove("https://srv/f/5");

		await expect(acquireFileBlobUrl("https://srv/f/5")).resolves.toBe(
			// The failed load created no object URL, so the retry takes mock-0.
			"blob:mock-0",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		releaseFileBlobUrl("https://srv/f/5");
	});
});
