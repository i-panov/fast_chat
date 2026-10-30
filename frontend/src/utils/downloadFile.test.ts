import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptFileStream, generateFileKey } from "../e2ee/file-crypto.ts";
import { downloadFile } from "./downloadFile.ts";

const createObjectURL = vi.fn((_blob: Blob): string => "blob:mock");
const revokeObjectURL = vi.fn();
const click = vi
	.spyOn(HTMLAnchorElement.prototype, "click")
	.mockImplementation(() => {});

function mockFetch(body: Blob | Uint8Array, ok = true, status = 200) {
	return vi.fn(() =>
		Promise.resolve(
			new Response(body as BodyInit, { status: ok ? 200 : status }),
		),
	);
}

beforeEach(() => {
	URL.createObjectURL = createObjectURL;
	URL.revokeObjectURL = revokeObjectURL;
	createObjectURL.mockClear();
	revokeObjectURL.mockClear();
	click.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("downloadFile", () => {
	it("downloads a plaintext file with an auth header", async () => {
		const fetchMock = mockFetch(new Blob(["plain data"]));
		vi.stubGlobal("fetch", fetchMock);

		await downloadFile("https://srv/files/1", "a.txt", "tok");

		expect(fetchMock).toHaveBeenCalledWith("https://srv/files/1", {
			headers: { Authorization: "Bearer tok" },
		});
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
	});

	it("omits the auth header without a token", async () => {
		const fetchMock = mockFetch(new Blob(["x"]));
		vi.stubGlobal("fetch", fetchMock);

		await downloadFile("https://srv/files/1", "a.txt");

		expect(fetchMock).toHaveBeenCalledWith("https://srv/files/1", {
			headers: {},
		});
	});

	it("throws on a failed response", async () => {
		vi.stubGlobal("fetch", mockFetch(new Blob(["e"]), false, 404));

		await expect(downloadFile("https://srv/files/1", "a.txt")).rejects.toThrow(
			"Failed to download file: 404",
		);
		expect(click).not.toHaveBeenCalled();
	});

	it("preserves the MIME type on decrypt", async () => {
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(
			new Blob(["secret file"]),
			fileKey,
		);
		vi.stubGlobal("fetch", mockFetch(ciphertext));

		await downloadFile(
			"https://srv/files/enc",
			"s.bin",
			"tok",
			fileKey,
			"video/mp4",
		);

		const blob = createObjectURL.mock.calls[0]?.[0];
		if (blob === undefined) throw new Error("createObjectURL not called");
		expect(blob.type).toBe("video/mp4");
	});

	it("decrypts the blob when a file key is given", async () => {
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(
			new Blob(["secret file"]),
			fileKey,
		);
		// Pass the raw bytes: wrapping a cross-realm Uint8Array in a jsdom
		// Blob mangles them, while Response accepts the view directly.
		vi.stubGlobal("fetch", mockFetch(ciphertext));

		await downloadFile("https://srv/files/enc", "s.bin", "tok", fileKey);

		expect(createObjectURL).toHaveBeenCalledTimes(1);
		const blob = createObjectURL.mock.calls[0]?.[0];
		if (blob === undefined) throw new Error("createObjectURL not called");
		const text = new TextDecoder().decode(await blob.arrayBuffer());
		expect(text).toBe("secret file");
	});
});
