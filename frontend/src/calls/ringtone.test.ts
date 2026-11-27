import { describe, expect, it, vi } from "vitest";
import { startRingtone } from "./ringtone.ts";

function fakeAudioContext() {
	const oscillator = {
		type: "",
		frequency: { value: 0 },
		connect: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
	};

	const close = vi.fn(() => Promise.resolve());

	class FakeAudioContext {
		destination = {};

		createOscillator() {
			return oscillator;
		}

		createGain() {
			return { gain: { value: 0 }, connect: vi.fn() };
		}

		resume() {
			return Promise.resolve();
		}

		close() {
			return close();
		}
	}

	vi.stubGlobal("AudioContext", FakeAudioContext);

	return { oscillator, close };
}

describe("startRingtone", () => {
	it("stops the oscillator only once", () => {
		const { oscillator, close } = fakeAudioContext();

		const ringtone = startRingtone();
		ringtone.stop();
		ringtone.stop();

		expect(oscillator.stop).toHaveBeenCalledTimes(1);
		expect(oscillator.start).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("clears its interval and unlock listeners on stop", () => {
		vi.useFakeTimers();
		try {
			const { oscillator } = fakeAudioContext();
			const ringtone = startRingtone();

			vi.advanceTimersByTime(2_000);
			expect(oscillator.frequency.value).not.toBe(0);

			ringtone.stop();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stays silent without the Web Audio API", () => {
		vi.stubGlobal("AudioContext", undefined);

		const ringtone = startRingtone();

		expect(() => ringtone.stop()).not.toThrow();
	});
});
