import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
		vi.unstubAllGlobals();
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
		vi.unstubAllGlobals();
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
		vi.unstubAllGlobals();
	});
});
