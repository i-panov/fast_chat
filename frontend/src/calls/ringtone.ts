// The ring of an incoming call. The sound is generated, so the repository
// holds no audio file.
const RING_FREQUENCIES = [440, 660];
const SWITCH_INTERVAL_MS = 800;
const VOLUME = 0.05;

export interface Ringtone {
	stop(): void;
}

// startRingtone plays the ring of an incoming call. A browser without the
// Web Audio API gets a silent ringtone: the call itself does not depend on
// it.
export function startRingtone(): Ringtone {
	const context = createAudioContext();

	if (context === null) {
		return { stop: () => {} };
	}

	const oscillator = context.createOscillator();
	const gain = context.createGain();

	oscillator.type = "sine";
	oscillator.frequency.value = RING_FREQUENCIES[0];
	gain.gain.value = VOLUME;

	oscillator.connect(gain);
	gain.connect(context.destination);
	oscillator.start();

	// The browser keeps the context suspended until the user interacts with
	// the page: the first click or key press starts the sound.
	const unlock = () => {
		void context.resume().catch(() => undefined);
	};

	window.addEventListener("pointerdown", unlock, { once: true });
	window.addEventListener("keydown", unlock, { once: true });

	let index = 0;
	let stopped = false;

	const timer = setInterval(() => {
		if (stopped) return;

		index = (index + 1) % RING_FREQUENCIES.length;
		oscillator.frequency.value = RING_FREQUENCIES[index];
	}, SWITCH_INTERVAL_MS);

	return {
		stop() {
			if (stopped) return;

			stopped = true;
			clearInterval(timer);
			window.removeEventListener("pointerdown", unlock);
			window.removeEventListener("keydown", unlock);
			oscillator.stop();
			void context.close().catch(() => undefined);
		},
	};
}

// createAudioContext opens the audio context, or returns null when the
// browser has none.
function createAudioContext(): AudioContext | null {
	const Ctor =
		typeof AudioContext !== "undefined"
			? AudioContext
			: typeof window !== "undefined"
				? (window as unknown as { webkitAudioContext?: typeof AudioContext })
						.webkitAudioContext
				: undefined;

	if (typeof Ctor === "undefined" || Ctor === undefined) return null;

	try {
		return new Ctor();
	} catch {
		return null;
	}
}
