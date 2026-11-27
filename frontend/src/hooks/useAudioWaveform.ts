import { useEffect, useState } from "react";

const BAR_COUNT = 28;
// Decoding a long track allocates the whole PCM buffer (a five-minute stereo
// file is about 100 MB) and freezes the page. Waveforms are useful for voice
// messages; a track above this size keeps the icon instead.
const MAX_WAVEFORM_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, number[]>();
// Object URLs are unique per mount, so the cache would otherwise grow with
// every rendered voice message. Keep the recently used peaks only.
const MAX_CACHED_WAVEFORMS = 100;

async function computePeaks(url: string): Promise<number[] | null> {
	const Ctx = typeof AudioContext === "undefined" ? undefined : AudioContext;
	if (Ctx === undefined) return null;

	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const declared = Number(response.headers.get("Content-Length") ?? "0");
		if (declared > MAX_WAVEFORM_BYTES) return null;

		const data = await response.arrayBuffer();
		if (data.byteLength > MAX_WAVEFORM_BYTES) return null;

		const context = new Ctx();
		try {
			const buffer = await context.decodeAudioData(data);
			const channel = buffer.getChannelData(0);
			const bucket = Math.max(1, Math.floor(channel.length / BAR_COUNT));
			const peaks: number[] = [];
			for (let i = 0; i < BAR_COUNT; i += 1) {
				let sum = 0;
				const start = i * bucket;
				const end = Math.min(channel.length, start + bucket);
				for (let j = start; j < end; j += 1) {
					sum += channel[j] * channel[j];
				}
				peaks.push(Math.sqrt(sum / Math.max(1, end - start)));
			}
			const max = Math.max(...peaks, 0.0001);
			return peaks.map((peak) => Math.max(0.12, peak / max));
		} finally {
			void context.close();
		}
	} catch {
		return null;
	}
}

export function useAudioWaveform(url: string | null): number[] | null {
	// nosemgrep: home.ilya.semgrep-rules.typescript.react.best-practice.react-props-in-state -- synchronous cache seed; the effect below updates it
	const [peaks, setPeaks] = useState<number[] | null>(() =>
		url === null ? null : (cache.get(url) ?? null),
	);

	useEffect(() => {
		if (url === null) {
			setPeaks(null);
			return;
		}

		const cached = cache.get(url);
		if (cached !== undefined) {
			setPeaks(cached);
			return;
		}

		let cancelled = false;
		void computePeaks(url).then((computed) => {
			if (cancelled || computed === null) return;
			cache.set(url, computed);
			if (cache.size > MAX_CACHED_WAVEFORMS) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			setPeaks(computed);
		});

		return () => {
			cancelled = true;
		};
	}, [url]);

	return peaks;
}
