import { useEffect, useState } from "react";

export function useVideoThumbnail(blobUrl: string | undefined): string | null {
	const [thumb, setThumb] = useState<string | null>(null);
	useEffect(() => {
		if (!blobUrl) {
			setThumb(null);
			return;
		}
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		video.playsInline = true;
		video.src = blobUrl;
		let cancelled = false;

		const onSeeked = () => {
			if (cancelled) return;
			const w = video.videoWidth || 320;
			const h = video.videoHeight || 240;
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			try {
				ctx.drawImage(video, 0, 0, w, h);
				setThumb(canvas.toDataURL("image/jpeg", 0.7));
			} catch {
				/* canvas tainted — fallback to icon */
			}
		};

		const onLoaded = () => {
			const seekTo =
				video.duration > 0 ? Math.min(0.1, video.duration / 2) : 0.1;
			video.currentTime = seekTo;
		};

		video.addEventListener("loadedmetadata", onLoaded);
		video.addEventListener("seeked", onSeeked);

		return () => {
			cancelled = true;
			video.removeEventListener("loadedmetadata", onLoaded);
			video.removeEventListener("seeked", onSeeked);
			video.removeAttribute("src");
			video.load();
		};
	}, [blobUrl]);
	return thumb;
}
