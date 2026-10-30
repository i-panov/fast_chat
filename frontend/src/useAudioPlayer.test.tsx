import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioProvider, useAudioPlayer } from "./useAudioPlayer.tsx";

type AudioBehavior = "resolve" | "reject";

const audioState = {
	behavior: "resolve" as AudioBehavior,
	playCalls: 0,
	pauseCalls: 0,
	endedHandlers: [] as Array<() => void>,
};

class FakeAudio {
	static last: FakeAudio | null = null;

	src = "";
	paused = true;

	constructor() {
		FakeAudio.last = this;
	}

	play() {
		audioState.playCalls += 1;
		this.paused = false;
		if (audioState.behavior === "reject") {
			return Promise.reject(new Error("play down"));
		}
		return Promise.resolve();
	}

	pause() {
		audioState.pauseCalls += 1;
		this.paused = true;
	}

	addEventListener(type: string, cb: () => void) {
		if (type === "ended") audioState.endedHandlers.push(cb);
	}

	removeEventListener(type: string, cb: () => void) {
		if (type === "ended") {
			audioState.endedHandlers = audioState.endedHandlers.filter(
				(f) => f !== cb,
			);
		}
	}

	emitEnded() {
		for (const cb of audioState.endedHandlers) cb();
	}
}

function audio(): FakeAudio {
	const current = FakeAudio.last;
	if (!current) throw new Error("no audio instance");

	return current;
}

function wrapper({ children }: { children: React.ReactNode }) {
	return <AudioProvider>{children}</AudioProvider>;
}

beforeEach(() => {
	FakeAudio.last = null;
	audioState.behavior = "resolve";
	audioState.playCalls = 0;
	audioState.pauseCalls = 0;
	audioState.endedHandlers = [];
	vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useAudioPlayer", () => {
	it("throws outside the provider", () => {
		expect(() => renderHook(() => useAudioPlayer())).toThrow(
			"useAudioPlayer must be used within AudioProvider",
		);
	});

	it("plays a new track", async () => {
		const { result } = renderHook(() => useAudioPlayer(), { wrapper });

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});

		expect(result.current.currentTrack?.fileId).toBe("f1");
		expect(result.current.isPlaying).toBe(true);
		expect(audio().src).toBe("blob:a");
	});

	it("toggles the same track", async () => {
		const { result } = renderHook(() => useAudioPlayer(), { wrapper });

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});
		expect(result.current.isPlaying).toBe(true);

		act(() => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
		});
		expect(result.current.isPlaying).toBe(false);
		expect(audioState.pauseCalls).toBeGreaterThan(0);

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});
		expect(result.current.isPlaying).toBe(true);
	});

	it("stops on playback failure", async () => {
		audioState.behavior = "reject";
		const { result } = renderHook(() => useAudioPlayer(), { wrapper });

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});

		expect(result.current.isPlaying).toBe(false);
	});

	it("pauses, resumes, stops and toggles", async () => {
		const { result } = renderHook(() => useAudioPlayer(), { wrapper });

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});

		act(() => {
			result.current.pause();
		});
		expect(result.current.isPlaying).toBe(false);

		await act(async () => {
			result.current.resume();
			await Promise.resolve();
		});
		expect(result.current.isPlaying).toBe(true);

		act(() => {
			result.current.toggle();
		});
		expect(result.current.isPlaying).toBe(false);

		await act(async () => {
			result.current.toggle();
			await Promise.resolve();
		});
		expect(result.current.isPlaying).toBe(true);

		act(() => {
			result.current.stop();
		});
		expect(result.current.currentTrack).toBeNull();
		expect(result.current.isPlaying).toBe(false);
		expect(audio().src).toBe("");
	});

	it("stops on track end", async () => {
		const { result } = renderHook(() => useAudioPlayer(), { wrapper });

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});

		act(() => {
			audio().emitEnded();
		});

		expect(result.current.isPlaying).toBe(false);
	});

	it("resume without a track does nothing", async () => {
		const { result } = renderHook(() => useAudioPlayer(), { wrapper });

		await act(async () => {
			result.current.resume();
			await Promise.resolve();
		});

		expect(audioState.playCalls).toBe(0);
		expect(result.current.isPlaying).toBe(false);
	});

	it("does not revoke foreign blob URLs on track change", async () => {
		// Track URLs are owned by the attachments (useDecryptedFileUrl):
		// revokeObjectURL is global, so revoking here would break the
		// owner's copy and poison the shared fileCache entry.
		const revoke = vi.fn();
		vi.stubGlobal("URL", { revokeObjectURL: revoke });

		try {
			const { result } = renderHook(() => useAudioPlayer(), { wrapper });

			await act(async () => {
				result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
				await Promise.resolve();
			});

			await act(async () => {
				result.current.play({ fileId: "f2", url: "blob:b", name: "b" });
				await Promise.resolve();
			});

			await act(async () => {
				result.current.stop();
				await Promise.resolve();
			});

			expect(revoke).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
			vi.stubGlobal("Audio", FakeAudio);
		}
	});

	it("rewinds the same track after it ended", async () => {
		const { result } = renderHook(() => useAudioPlayer(), { wrapper });

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});

		(audio() as unknown as { ended: boolean }).ended = true;
		(audio() as unknown as { paused: boolean }).paused = true;

		await act(async () => {
			result.current.play({ fileId: "f1", url: "blob:a", name: "a" });
			await Promise.resolve();
		});

		expect((audio() as unknown as { currentTime?: number }).currentTime).toBe(
			0,
		);
		expect(result.current.isPlaying).toBe(true);
	});
});
