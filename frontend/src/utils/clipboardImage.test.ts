import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInfo } from "../types/api.ts";
import { copyImageToClipboard } from "./clipboardImage.ts";

const file: FileInfo = {
	id: "f1",
	mimeType: "image/png",
	size: 3,
	originalName: "cat.png",
	fileType: "photo",
	url: "/api/files/f1",
};

const write = vi.fn(() => Promise.resolve());

class FakeClipboardItem {
	constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
}

beforeEach(() => {
	write.mockClear();
	vi.stubGlobal("ClipboardItem", FakeClipboardItem);
	Object.defineProperty(navigator, "clipboard", {
		value: { write },
		configurable: true,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(() =>
			Promise.resolve(new Response(new Blob(["png"], { type: "image/png" }))),
		),
	);
});

// biome-ignore lint/security/noSecrets: the suite name is not a secret
describe("copyImageToClipboard", () => {
	it("puts a PNG attachment on the clipboard", async () => {
		await copyImageToClipboard(file, undefined, "tok");

		expect(write).toHaveBeenCalledTimes(1);
		const [items] = write.mock.calls[0] as unknown as [FakeClipboardItem[]];
		const png = await items[0]?.items["image/png"];
		expect(png?.type).toBe("image/png");
	});

	it("reports an unsupported clipboard instead of silently doing nothing", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});

		await expect(copyImageToClipboard(file, undefined, "tok")).rejects.toThrow(
			"clipboard images are not supported",
		);
	});
});
