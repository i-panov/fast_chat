import { describe, expect, it } from "vitest";
import { formatSize, getFileType } from "./files.ts";

describe("formatSize", () => {
	it("formats bytes", () => {
		expect(formatSize(0)).toBe("0 B");
		expect(formatSize(512)).toBe("512 B");
		expect(formatSize(1023)).toBe("1023 B");
	});

	it("formats kilobytes with one decimal", () => {
		expect(formatSize(1024)).toBe("1.0 KB");
		expect(formatSize(1536)).toBe("1.5 KB");
	});

	it("formats megabytes with one decimal", () => {
		expect(formatSize(1024 * 1024)).toBe("1.0 MB");
		expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
	});
});

describe("getFileType", () => {
	it("classifies by MIME prefix", () => {
		expect(getFileType("image/png")).toBe("photo");
		expect(getFileType("image/jpeg")).toBe("photo");
		expect(getFileType("video/mp4")).toBe("video");
		expect(getFileType("audio/mpeg")).toBe("audio");
	});

	it("falls back to file", () => {
		expect(getFileType("application/pdf")).toBe("file");
		expect(getFileType("")).toBe("file");
	});
});
