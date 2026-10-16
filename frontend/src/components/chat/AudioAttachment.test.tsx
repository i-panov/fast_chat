import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../useAuth.tsx";
import { AudioAttachment } from "./AudioAttachment.tsx";
import {
	photoFile,
	seedAccount,
	stubBlobUrls,
} from "./attachmentTestUtils.tsx";

const playerHolder = vi.hoisted(() => ({
	play: (..._args: unknown[]) => {},
	currentTrack: null as { fileId: string } | null,
	isPlaying: false,
}));

vi.mock("../../useAudioPlayer.tsx", () => ({
	useAudioPlayer: () => playerHolder,
}));

function audioFile(url = "https://srv/a/1") {
	return photoFile({
		id: "a1",
		mimeType: "audio/mpeg",
		originalName: "song.mp3",
		fileType: "audio",
		url,
	});
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	stubBlobUrls();
	playerHolder.play = (..._args: unknown[]) => {};
	playerHolder.currentTrack = null;
	playerHolder.isPlaying = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.resolve(new Response(new Blob(["audio"])))),
	);
});

const LOAD_AUDIO_FAILED = /Failed to load audio|media\.loadAudioFailed/;

describe("AudioAttachment", () => {
	it("plays the track on click", async () => {
		const play = vi.fn();
		playerHolder.play = play;
		render(
			<MantineProvider>
				<AuthProvider>
					<AudioAttachment file={audioFile()} />
				</AuthProvider>
			</MantineProvider>,
		);

		await screen.findByText("song.mp3");
		fireEvent.click(screen.getByRole("button"));

		expect(play).toHaveBeenCalledWith({
			fileId: "a1",
			url: "blob:mock",
			name: "song.mp3",
		});
		vi.unstubAllGlobals();
	});

	it("shows the pause icon while playing", async () => {
		playerHolder.currentTrack = { fileId: "a1" };
		playerHolder.isPlaying = true;
		render(
			<MantineProvider>
				<AuthProvider>
					<AudioAttachment file={audioFile()} />
				</AuthProvider>
			</MantineProvider>,
		);

		await screen.findByText("song.mp3");
		expect(screen.getByText("⏸")).toBeTruthy();
		vi.unstubAllGlobals();
	});

	it("shows an error when loading fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("down"))),
		);
		const failing = audioFile("https://srv/err-a");
		render(
			<MantineProvider>
				<AuthProvider>
					<AudioAttachment file={failing} />
				</AuthProvider>
			</MantineProvider>,
		);

		await screen.findByText(LOAD_AUDIO_FAILED);
		vi.unstubAllGlobals();
	});

	it("waits for the blob URL", async () => {
		render(
			<MantineProvider>
				<AuthProvider>
					<AudioAttachment file={audioFile()} />
				</AuthProvider>
			</MantineProvider>,
		);

		await waitFor(() => {
			expect(screen.queryByRole("button")).toBeTruthy();
		});
		vi.unstubAllGlobals();
	});
});
