import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInfo } from "../../../types/api.ts";
import { AuthProvider } from "../../../useAuth.tsx";
import { MessageAttachments } from "./MessageAttachments.tsx";

const playerHolder = vi.hoisted(() => ({
	play: (..._args: unknown[]) => {},
	currentTrack: null,
	isPlaying: false,
}));

vi.mock("../../../useAudioPlayer.tsx", () => ({
	useAudioPlayer: () => playerHolder,
}));

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

function file(
	id: string,
	fileType: FileInfo["fileType"],
	mime: string,
): FileInfo {
	return {
		id,
		mimeType: mime,
		size: 10,
		originalName: `${id}.bin`,
		fileType,
		url: `https://srv/${id}`,
	};
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn((_url: string, init?: RequestInit) => {
			if ((init?.method ?? "GET") === "HEAD") {
				return new Response(null, {
					headers: { "Content-Length": "0", "Content-Type": "video/mp4" },
				});
			}
			return Promise.resolve(new Response(new Blob(["data"])));
		}),
	);
});

describe("message attachments", () => {
	it("renders every file kind and dims queued uploads", async () => {
		const onPhotoClick = vi.fn();
		const { container } = render(
			<MantineProvider>
				<AuthProvider>
					<MessageAttachments
						files={[
							file("p1", "photo", "image/png"),
							file("v1", "video", "video/mp4"),
							file("a1", "audio", "audio/mpeg"),
							file("f1", "file", "application/pdf"),
						]}
						status="queued"
						onPhotoClick={onPhotoClick}
					/>
				</AuthProvider>
			</MantineProvider>,
		);

		expect(await screen.findByAltText("p1.bin")).toBeTruthy();
		expect(container.querySelector("video")).toBeTruthy();
		expect(screen.getByText("f1.bin")).toBeTruthy();
		expect(container.innerHTML).toContain("opacity: 0.6");
		vi.unstubAllGlobals();
	});
});
