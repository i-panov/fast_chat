import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptedFilesRepo } from "../db/decryptedFilesRepo.ts";
import { fileCacheRepo } from "../db/fileCacheRepo.ts";
import { encryptFileStream, generateFileKey } from "../e2ee/file-crypto.ts";
import type { FileInfo } from "../types/api.ts";
import { useDecryptedFileUrl } from "./useDecryptedFileUrl.ts";

const createObjectURL = vi.fn((_blob: Blob): string => "blob:mock");

function file(overrides: Partial<FileInfo> = {}): FileInfo {
	return {
		id: "f1",
		mimeType: "text/plain",
		size: 10,
		originalName: "a.txt",
		fileType: "file",
		url: "https://srv/f/1",
		hash: "h1",
		...overrides,
	};
}

beforeEach(() => {
	URL.createObjectURL = createObjectURL;
	URL.revokeObjectURL = vi.fn();
	createObjectURL.mockClear();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useDecryptedFileUrl", () => {
	it("returns nulls without a file", () => {
		const { result } = renderHook(() =>
			useDecryptedFileUrl(undefined, undefined, "tok"),
		);

		expect(result.current.blobUrl).toBeNull();
	});

	it("passes plaintext files through", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(new Blob(["plain"])))),
		);

		const { result } = renderHook(() =>
			useDecryptedFileUrl(file(), undefined, "tok"),
		);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});
		vi.unstubAllGlobals();
	});

	it("does not return the previous file URL after a source switch", async () => {
		let releaseSecond = (_r: Response) => {};
		const second = new Promise<Response>((resolve) => {
			releaseSecond = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) =>
				url.includes("/f/1")
					? Promise.resolve(new Response(new Blob(["one"])))
					: second,
			),
		);

		const { result, rerender } = renderHook(
			({ url }: { url: string }) =>
				useDecryptedFileUrl(file({ url }), undefined, "tok"),
			{ initialProps: { url: "https://srv/f/1" } },
		);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});

		rerender({ url: "https://srv/f/2" });

		// The old URL belongs to the previous file and has already been
		// released: it must not be shown while the new file loads.
		expect(result.current.blobUrl).toBeNull();
		expect(result.current.loading).toBe(true);

		releaseSecond(new Response(new Blob(["two"])));
		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});
		vi.unstubAllGlobals();
	});

	it("decrypts files with a matching key", async () => {
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(new Blob(["secret"]), fileKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(new Response(ciphertext.buffer as ArrayBuffer)),
			),
		);

		const { result } = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});

		const calls = createObjectURL.mock.calls;
		const blob = calls[calls.length - 1]?.[0];
		if (blob === undefined) throw new Error("createObjectURL not called");
		const text = new TextDecoder().decode(await blob.arrayBuffer());
		expect(text).toBe("secret");
		vi.unstubAllGlobals();
	});

	it("returns a local pending blob without decrypting it", async () => {
		// The optimistic row of a message that is still uploading points at
		// the local plaintext blob while the message itself is encrypted, so
		// a key for the file exists. Decrypting those bytes fails and the
		// bubble shows "could not load image" for the whole upload.
		const fileKey = await generateFileKey();
		const fetchMock = vi.fn(() => Promise.reject(new Error("no fetch")));
		vi.stubGlobal("fetch", fetchMock);
		const getCached = vi.spyOn(decryptedFilesRepo, "get");

		const { result } = renderHook(() =>
			useDecryptedFileUrl(
				file({ id: "pending-1", url: "blob:pending-1", hash: "h1" }),
				{ h1: fileKey },
				"tok",
			),
		);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:pending-1");
		});
		expect(result.current.error).toBeNull();
		// No decryption/cache path: the local plaintext URL is returned as-is.
		expect(getCached).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("serves the persisted plaintext after a restart without the network", async () => {
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(new Blob(["secret"]), fileKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(new Response(ciphertext.buffer as ArrayBuffer)),
			),
		);

		const first = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);
		await waitFor(() => {
			expect(first.result.current.blobUrl).toBe("blob:mock");
		});
		first.unmount();

		// A restart has no in-memory ciphertext and no network: only the
		// persisted plaintext can satisfy the view.
		const { clearFileCache } = await import("../utils/fileCache.ts");
		clearFileCache();
		await fileCacheRepo.remove("https://srv/f/1");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("offline"))),
		);

		const second = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);
		await waitFor(() => {
			expect(second.result.current.blobUrl).toBe("blob:mock");
		});
		expect(second.result.current.error).toBeNull();

		const calls = createObjectURL.mock.calls;
		const blob = calls[calls.length - 1]?.[0];
		if (blob === undefined) throw new Error("createObjectURL not called");
		const text = new TextDecoder().decode(await blob.arrayBuffer());
		expect(text).toBe("secret");
		vi.unstubAllGlobals();
	});

	it("surfaces an error on decryption failure instead of ciphertext", async () => {
		const fileKey = await generateFileKey();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(new Blob(["junk"])))),
		);

		const { result } = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);

		// The undecryptable blob must not be handed out as the file (that
		// would download ciphertext under the original name): blobUrl stays
		// null and the failure is reported via error.
		await waitFor(() => {
			expect(result.current.error).toBeTruthy();
		});
		expect(result.current.blobUrl).toBeNull();
		vi.unstubAllGlobals();
	});

	it("checks the plaintext cache before requesting the ciphertext", async () => {
		// The cached plaintext is enough on its own: the ciphertext request
		// must not start while the lookup is still running, and a cache hit
		// must not fetch anything at all.
		const fileKey = await generateFileKey();
		const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(fileCacheRepo, "get").mockResolvedValue(undefined);

		let releaseLookup = () => {};
		const lookupGate = new Promise<void>((resolve) => {
			releaseLookup = resolve;
		});
		vi.spyOn(decryptedFilesRepo, "get").mockImplementation(async () => {
			await lookupGate;
		});

		const { result } = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.current.loading).toBe(true);

		releaseLookup();
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(result.current.error).toBeTruthy();
		});
		expect(result.current.blobUrl).toBeNull();
		vi.unstubAllGlobals();
	});

	it("serves a cached plaintext without downloading the ciphertext", async () => {
		const fileKey = await generateFileKey();
		const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(decryptedFilesRepo, "get").mockResolvedValue({
			key: "k",
			bytes: new TextEncoder().encode("cached").buffer,
			mimeType: "text/plain",
			cachedAt: 0,
			lastAccessedAt: 0,
			size: 6,
		});

		const { result } = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});
		expect(result.current.error).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("keeps loading until the plaintext resolves instead of flashing an error", async () => {
		// The ciphertext request can outlive the first render: the gap used
		// to be rendered as "could not load" because the hook looked idle.
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(new Blob(["secret"]), fileKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(new Response(ciphertext.buffer as ArrayBuffer)),
			),
		);

		const { result } = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);

		expect(result.current.loading).toBe(true);
		expect(result.current.error).toBeNull();
		expect(result.current.blobUrl).toBeNull();

		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});
		expect(result.current.error).toBeNull();
		vi.unstubAllGlobals();
	});
});
