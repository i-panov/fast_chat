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
			return Promise.resolve();
		}
	}

	vi.stubGlobal("AudioContext", FakeAudioContext);

	return oscillator;
}

describe("startRingtone", () => {
	it("stops the oscillator only once", () => {
		const oscillator = fakeAudioContext();

		const ringtone = startRingtone();
		ringtone.stop();
		ringtone.stop();

		expect(oscillator.stop).toHaveBeenCalledTimes(1);
		expect(oscillator.start).toHaveBeenCalledTimes(1);
	});

	it("stays silent without the Web Audio API", () => {
		vi.stubGlobal("AudioContext", undefined);

		const ringtone = startRingtone();

		expect(() => ringtone.stop()).not.toThrow();
	});
});
