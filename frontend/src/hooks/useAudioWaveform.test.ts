import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudioWaveform } from "./useAudioWaveform.ts";

class FakeAudioContext {
	decodeAudioData = vi.fn(() =>
		Promise.resolve({
			getChannelData: () => new Float32Array([0.5, 0.2, 0.9, 0.1]),
		}),
	);
	close = vi.fn(() => Promise.resolve());
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useAudioWaveform", () => {
	it("returns null when the browser has no audio context", () => {
		vi.stubGlobal("AudioContext", undefined);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useAudioWaveform("blob:voice"));

		expect(result.current).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("computes peaks and caches them per URL", async () => {
		vi.stubGlobal("AudioContext", FakeAudioContext);
		const fetchMock = vi.fn(() =>
			Promise.resolve(new Response(new ArrayBuffer(4))),
		);
		vi.stubGlobal("fetch", fetchMock);

		const first = renderHook(() => useAudioWaveform("blob:voice"));
		await waitFor(() => {
			expect(first.result.current).toHaveLength(28);
		});
		first.unmount();

		const second = renderHook(() => useAudioWaveform("blob:voice"));
		expect(second.result.current).toHaveLength(28);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("skips a file that is too large to decode", async () => {
		vi.stubGlobal("AudioContext", FakeAudioContext);
		const arrayBuffer = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					headers: new Headers({ "Content-Length": String(64 * 1024 * 1024) }),
					arrayBuffer,
				} as unknown as Response),
			),
		);

		const { result } = renderHook(() => useAudioWaveform("blob:music"));
		await Promise.resolve();

		expect(result.current).toBeNull();
		expect(arrayBuffer).not.toHaveBeenCalled();
	});

	it("reports no peaks for a failed request", async () => {
		vi.stubGlobal("AudioContext", FakeAudioContext);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("{}", { status: 404 }))),
		);

		const { result } = renderHook(() => useAudioWaveform("blob:gone"));
		await Promise.resolve();

		expect(result.current).toBeNull();
	});
});
