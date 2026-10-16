import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LargeFileThreshold } from "../types/api.ts";
import { usePendingFiles } from "./usePendingFiles.ts";

const revokeObjectURL = vi.fn();

function smallFile(name = "a.txt", type = "text/plain") {
	return new File(["data"], name, { type });
}

function largeFile(): File {
	return {
		name: "big.bin",
		size: LargeFileThreshold + 1,
		type: "application/octet-stream",
	} as File;
}

beforeEach(() => {
	let n = 0;
	URL.createObjectURL = vi.fn(() => `blob:mock-${n++}`);
	revokeObjectURL.mockClear();
	URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("usePendingFiles", () => {
	it("attaches small files encrypted", async () => {
		const { result } = renderHook(() => usePendingFiles());

		await act(async () => {
			await result.current.handleAttachFiles([
				smallFile("a.txt", "text/plain"),
				smallFile("b.png", "image/png"),
			]);
		});

		expect(result.current.pendingFiles).toHaveLength(2);
		expect(result.current.pendingFiles[0]).toMatchObject({
			originalName: "a.txt",
			mimeType: "text/plain",
			fileType: "file",
			encrypted: true,
		});
		expect(result.current.pendingFiles[1].fileType).toBe("photo");
	});

	it("encrypts large files by default", async () => {
		const { result } = renderHook(() => usePendingFiles());

		await act(async () => {
			await result.current.handleAttachFiles([largeFile()]);
		});

		expect(result.current.pendingFiles[0].encrypted).toBe(true);
	});

	it("asks before adding large files", async () => {
		const onLargeFile = vi.fn(
			(_file: File, resolve: (encrypt: boolean) => void) => {
				resolve(false);
			},
		);
		const { result } = renderHook(() => usePendingFiles(onLargeFile));

		await act(async () => {
			await result.current.handleAttachFiles([largeFile()]);
		});

		expect(onLargeFile).toHaveBeenCalledTimes(1);
		expect(result.current.pendingFiles[0].encrypted).toBe(false);
	});

	it("removes a file and revokes its URL", async () => {
		const { result } = renderHook(() => usePendingFiles());

		await act(async () => {
			await result.current.handleAttachFiles([smallFile()]);
		});
		const [entry] = result.current.pendingFiles;

		act(() => {
			result.current.handleRemoveFile(entry.id);
		});

		expect(result.current.pendingFiles).toEqual([]);
		expect(revokeObjectURL).toHaveBeenCalledWith(entry.blobUrl);
	});

	it("clears everything at once", async () => {
		const { result } = renderHook(() => usePendingFiles());

		await act(async () => {
			await result.current.handleAttachFiles([smallFile("a"), smallFile("b")]);
		});

		act(() => {
			result.current.clearAllPendingFiles();
		});

		expect(result.current.pendingFiles).toEqual([]);
		expect(revokeObjectURL).toHaveBeenCalledTimes(2);
	});

	it("revokes remaining URLs on unmount", async () => {
		const { result, unmount } = renderHook(() => usePendingFiles());

		await act(async () => {
			await result.current.handleAttachFiles([smallFile()]);
		});
		const [entry] = result.current.pendingFiles;

		unmount();

		expect(revokeObjectURL).toHaveBeenCalledWith(entry.blobUrl);
	});
});
