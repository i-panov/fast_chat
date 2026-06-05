import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePendingFiles } from "./usePendingFiles";

// Моки для URL
const mockRevokeObjectURL = vi.fn();
const mockCreateObjectURL = vi.fn(() => "blob:mock-url");

vi.mock("react", async () => {
	const actual = await vi.importActual("react");
	return {
		...(actual as object),
		useRef: vi.fn(),
	};
});

global.URL = {
	...global.URL,
	createObjectURL: mockCreateObjectURL,
	revokeObjectURL: mockRevokeObjectURL,
} as unknown as typeof URL;

describe("usePendingFiles", () => {
	it("возвращает пустой массив файлов по умолчанию", () => {
		const { result } = renderHook(() => usePendingFiles());
		expect(result.current.pendingFiles).toEqual([]);
	});

	it("добавляет файлы через handleAttachFiles", () => {
		const file1 = new File(["test"], "test1.txt", { type: "text/plain" });
		const file2 = new File(["test"], "test2.png", { type: "image/png" });

		const { result } = renderHook(() => usePendingFiles());

		act(() => {
			result.current.handleAttachFiles([file1, file2]);
		});

		expect(result.current.pendingFiles).toHaveLength(2);
		expect(result.current.pendingFiles[0].originalName).toBe("test1.txt");
		expect(result.current.pendingFiles[1].originalName).toBe("test2.png");
	});

	it("определяет тип файла по MIME", () => {
		const photo = new File(["test"], "photo.jpg", { type: "image/jpeg" });
		const video = new File(["test"], "video.mp4", { type: "video/mp4" });
		const audio = new File(["test"], "audio.mp3", { type: "audio/mp3" });
		const doc = new File(["test"], "doc.pdf", { type: "application/pdf" });

		const { result } = renderHook(() => usePendingFiles());

		act(() => {
			result.current.handleAttachFiles([photo, video, audio, doc]);
		});

		expect(result.current.pendingFiles[0].fileType).toBe("photo");
		expect(result.current.pendingFiles[1].fileType).toBe("video");
		expect(result.current.pendingFiles[2].fileType).toBe("audio");
		expect(result.current.pendingFiles[3].fileType).toBe("file");
	});

	it("удаляет файл и вызывает revokeObjectURL", () => {
		const file = new File(["test"], "test.txt", { type: "text/plain" });

		const { result } = renderHook(() => usePendingFiles());

		act(() => {
			result.current.handleAttachFiles([file]);
		});

		const fileId = result.current.pendingFiles[0].id;
		const blobUrl = result.current.pendingFiles[0].blobUrl;

		act(() => {
			result.current.handleRemoveFile(fileId);
		});

		expect(result.current.pendingFiles).toHaveLength(0);
		expect(mockRevokeObjectURL).toHaveBeenCalledWith(blobUrl);
	});

	it("очищает все файлы через handleClearAll", () => {
		const file1 = new File(["test"], "test1.txt", { type: "text/plain" });
		const file2 = new File(["test"], "test2.txt", { type: "text/plain" });

		const { result } = renderHook(() => usePendingFiles());

		act(() => {
			result.current.handleAttachFiles([file1, file2]);
		});

		expect(result.current.pendingFiles).toHaveLength(2);

		act(() => {
			result.current.handleClearAll();
		});

		expect(result.current.pendingFiles).toHaveLength(0);
		expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2);
	});
});
