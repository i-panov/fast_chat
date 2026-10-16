import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("falls back to the encrypted URL on decryption failure", async () => {
		const fileKey = await generateFileKey();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(new Blob(["junk"])))),
		);

		const { result } = renderHook(() =>
			useDecryptedFileUrl(file(), { h1: fileKey }, "tok"),
		);

		// Encrypted URL from the fetch layer; the undecryptable blob falls
		// back to it instead of crashing.
		await waitFor(() => {
			expect(result.current.blobUrl).toBe("blob:mock");
		});
		vi.unstubAllGlobals();
	});
});
