import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptFileStream, generateFileKey } from "../../e2ee/file-crypto.ts";
import {
	photoFile,
	renderWithAccount,
	seedAccount,
	stubBlobUrls,
} from "./attachmentTestUtils.tsx";
import { VideoAttachment } from "./VideoAttachment.tsx";

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	stubBlobUrls();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function videoFile(url = "https://srv/v/1", hash?: string) {
	return photoFile({
		id: "v1",
		mimeType: "video/mp4",
		originalName: "vid.mp4",
		fileType: "video",
		url,
		hash,
	});
}

const LOAD_VIDEO_FAILED = /Failed to load video|media\.loadVideoFailed/;

describe("VideoAttachment", () => {
	it("streams unencrypted video", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "HEAD") {
					return Promise.resolve(
						new Response(null, {
							headers: { "Content-Length": "0", "Content-Type": "video/mp4" },
						}),
					);
				}
				return Promise.resolve(new Response(new Blob(["video"])));
			}),
		);
		const { container } = renderWithAccount(
			<VideoAttachment file={videoFile()} />,
		);

		await waitFor(() => {
			expect(container.querySelector("video")).toBeTruthy();
		});
	});

	it("decrypts encrypted video", async () => {
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(
			new Blob(["secret video"]),
			fileKey,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(new Response(ciphertext.buffer as ArrayBuffer)),
			),
		);
		const { container } = renderWithAccount(
			<VideoAttachment
				file={videoFile("https://srv/v/1", "h1")}
				fileKeys={{ h1: fileKey }}
			/>,
		);

		await waitFor(() => {
			expect(container.querySelector("video")).toBeTruthy();
		});
	});

	it("decrypts id-keyed video without a hash", async () => {
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(
			new Blob(["secret video"]),
			fileKey,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(new Response(ciphertext.buffer as ArrayBuffer)),
			),
		);
		const file = videoFile("https://srv/v/noid");
		// No hash on the file; the key is indexed by file id.
		delete (file as { hash?: string }).hash;
		const { container } = renderWithAccount(
			<VideoAttachment file={file} fileKeys={{ v1: fileKey }} />,
		);
		await waitFor(() => {
			expect(container.querySelector("video")).toBeTruthy();
		});
	});

	it("renders the player while a streamed video is still buffering", async () => {
		// The MediaSource stays closed until a media element uses its object
		// URL. When the player was hidden behind the loader, it never opened
		// and the video stayed on the spinner forever.
		class PendingMediaSource {
			static isTypeSupported(): boolean {
				return true;
			}

			readyState = "open";

			addEventListener(type: string, callback: () => void): void {
				if (type === "sourceopen") {
					setTimeout(callback, 0);
				}
			}

			addSourceBuffer() {
				return {
					addEventListener: () => {},
					removeEventListener: () => {},
					appendBuffer: () => {},
				};
			}

			endOfStream(): void {}
		}
		vi.stubGlobal("MediaSource", PendingMediaSource);
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "HEAD") {
					return Promise.resolve(
						new Response(null, {
							headers: { "Content-Length": "100", "Content-Type": "video/mp4" },
						}),
					);
				}
				return Promise.resolve(new Response(new Uint8Array(100)));
			}),
		);

		const { container } = renderWithAccount(
			<VideoAttachment file={videoFile()} />,
		);

		await waitFor(() => {
			expect(container.querySelector("video")).toBeTruthy();
		});
		expect(screen.queryByText(LOAD_VIDEO_FAILED)).toBeNull();
	});

	it("shows an error when loading fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("down"))),
		);
		renderWithAccount(
			<VideoAttachment file={videoFile("https://srv/err-v")} />,
		);

		await screen.findByText(LOAD_VIDEO_FAILED);
	});
});
