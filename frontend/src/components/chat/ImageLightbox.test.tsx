import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInfo } from "../../types/api.ts";
import { AuthProvider } from "../../useAuth.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";

const LOAD_FAILED = /Failed to load image|media\.loadImageFailed/;

function seedAccount() {
	localStorage.setItem(
		"accounts",
		JSON.stringify([
			{
				token: "tok",
				user: { id: "alice:test", nick: "alice" },
				email: "a@example.com",
				expiresAt: "2027-01-01T00:00:00Z",
			},
		]),
	);
	sessionStorage.setItem("activeToken", "tok");
}

function image(id: string, name: string): FileInfo {
	return {
		id,
		mimeType: "image/png",
		size: 10,
		originalName: name,
		fileType: "photo",
		url: `https://srv/${id}`,
	};
}

function renderLightbox(props: {
	images: FileInfo[];
	startIndex?: number;
	onClose?: () => void;
}) {
	return render(
		<MantineProvider>
			<AuthProvider>
				<ImageLightbox
					images={props.images}
					startIndex={props.startIndex ?? 0}
					onClose={props.onClose ?? (() => {})}
				/>
			</AuthProvider>
		</MantineProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.resolve(new Response(new Blob(["pic"])))),
	);
});

describe("image lightbox", () => {
	it("renders nothing without images", () => {
		const { container } = renderLightbox({ images: [] });

		expect(container.querySelector("img")).toBeNull();
	});

	it("shows the starting image and counters", async () => {
		renderLightbox({ images: [image("a", "a.png"), image("b", "b.png")] });

		expect(await screen.findByAltText("a.png")).toBeTruthy();
		expect(screen.getByText("1 / 2")).toBeTruthy();
		vi.unstubAllGlobals();
	});

	it("navigates with buttons and keys", async () => {
		const onClose = vi.fn();
		renderLightbox({
			images: [image("a", "a.png"), image("b", "b.png")],
			onClose,
		});

		await screen.findByAltText("a.png");

		const buttons = [...document.querySelectorAll("button")];
		// close, prev, next
		fireEvent.click(buttons[2]);
		expect(await screen.findByAltText("b.png")).toBeTruthy();
		expect(screen.getByText("2 / 2")).toBeTruthy();

		fireEvent.keyDown(document.body, { key: "ArrowLeft" });
		expect(await screen.findByAltText("a.png")).toBeTruthy();

		fireEvent.keyDown(document.body, { key: "ArrowRight" });
		expect(await screen.findByAltText("b.png")).toBeTruthy();

		fireEvent.keyDown(document.body, { key: "Escape" });
		// Both the lightbox handler and Mantine's Modal react to Escape.
		expect(onClose).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("wraps around the gallery", async () => {
		renderLightbox({ images: [image("a", "a.png"), image("b", "b.png")] });

		await screen.findByAltText("a.png");
		const buttons = [...document.querySelectorAll("button")];
		fireEvent.click(buttons[1]);

		expect(await screen.findByAltText("b.png")).toBeTruthy();
		vi.unstubAllGlobals();
	});

	it("closes from the corner button", async () => {
		const onClose = vi.fn();
		renderLightbox({
			images: [image("a", "a.png")],
			onClose,
		});

		await screen.findByAltText("a.png");
		const buttons = [...document.querySelectorAll("button")];
		fireEvent.click(buttons[0]);

		expect(onClose).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});

	it("shows an error when loading fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("down"))),
		);
		renderLightbox({ images: [image("z", "z.png")] });

		await screen.findByText(LOAD_FAILED);
		vi.unstubAllGlobals();
	});
});
