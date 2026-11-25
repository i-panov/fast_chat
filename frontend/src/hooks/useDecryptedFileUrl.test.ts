import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		expect(createObjectURL).not.toHaveBeenCalled();
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
});
