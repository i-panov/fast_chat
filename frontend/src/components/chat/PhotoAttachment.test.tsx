import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	photoFile,
	renderWithAccount,
	seedAccount,
	stubBlobUrls,
} from "./attachmentTestUtils.tsx";
import { PhotoAttachment } from "./PhotoAttachment.tsx";

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	stubBlobUrls();
});

function stubFetch(body: Blob) {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.resolve(new Response(body))),
	);
}

const LOAD_IMAGE_FAILED = /Failed to load image|media\.loadImageFailed/;

describe("PhotoAttachment", () => {
	it("renders the image and forwards clicks", async () => {
		stubFetch(new Blob(["pic"]));
		const onPhotoClick = vi.fn();
		renderWithAccount(
			<PhotoAttachment file={photoFile()} onPhotoClick={onPhotoClick} />,
		);

		const img = await screen.findByAltText("pic.png");
		expect(img.getAttribute("src")).toBe("blob:mock");

		fireEvent.click(img);
		expect(onPhotoClick).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});

	it("links out without a click handler", async () => {
		stubFetch(new Blob(["pic"]));
		const { container } = renderWithAccount(
			<PhotoAttachment file={photoFile()} />,
		);

		await screen.findByAltText("pic.png");
		expect(container.querySelector("a")?.getAttribute("href")).toBe(
			"blob:mock",
		);
		vi.unstubAllGlobals();
	});

	it("shows an error when loading fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("down"))),
		);
		// Fresh URL: the module-level file cache keeps entries between tests.
		renderWithAccount(
			<PhotoAttachment file={photoFile({ url: "https://srv/err-1" })} />,
		);

		await screen.findByText(LOAD_IMAGE_FAILED);
		vi.unstubAllGlobals();
	});

	it("shows a loader while fetching", async () => {
		let resolveFetch!: (r: Response) => void;
		const fetchMock = vi.fn(
			() =>
				new Promise<Response>((res) => {
					resolveFetch = res;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		renderWithAccount(
			<PhotoAttachment file={photoFile({ url: "https://srv/loading-1" })} />,
		);

		// The fetch starts after the IDB lookup, in a microtask.
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});
		expect(document.body.innerHTML).toContain("mantine-Loader-root");

		resolveFetch(new Response(new Blob(["pic"])));
		await screen.findByAltText("pic.png");
		vi.unstubAllGlobals();
	});
});
