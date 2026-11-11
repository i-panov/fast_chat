import { useEffect, useState } from "react";

const BAR_COUNT = 28;
const cache = new Map<string, number[]>();

async function computePeaks(url: string): Promise<number[] | null> {
	const Ctx = typeof AudioContext === "undefined" ? undefined : AudioContext;
	if (Ctx === undefined) return null;

	try {
		const response = await fetch(url);
		const data = await response.arrayBuffer();
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
			setPeaks(computed);
		});

		return () => {
			cancelled = true;
		};
	}, [url]);

	return peaks;
}
