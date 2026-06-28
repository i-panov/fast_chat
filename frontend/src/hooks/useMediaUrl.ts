import { useEffect, useRef, useState } from "react";

const CHUNK_SIZE = 1024 * 1024; // 1MB

function findSupportedMime(mimeType: string): string | null {
	if (MediaSource.isTypeSupported(mimeType)) return mimeType;

	const base = mimeType.split(";")[0].trim();
	const candidates: Record<string, string[]> = {
		"video/mp4": [
			"avc1.42E01E,mp4a.40.2",
			"avc1.4D401E,mp4a.40.2",
			"mp4a.40.2",
		],
		"audio/mp4": ["mp4a.40.2", "mp4a.40.5"],
		"video/webm": ["vp8,vorbis", "vp9,opus"],
		"audio/webm": ["vorbis", "opus"],
		"video/ogg": ["theora,vorbis"],
		"audio/ogg": ["vorbis", "opus"],
	};

	const codecs = candidates[base];
	if (codecs) {
		for (const c of codecs) {
			const mime = `${base}; codecs="${c}"`;
			if (MediaSource.isTypeSupported(mime)) return mime;
		}
	}

	return null;
}

export function useMediaUrl(
	fileUrl: string | undefined,
	token: string | undefined,
): { mediaUrl: string | null; loading: boolean; error: Error | null } {
	const [mediaUrl, setMediaUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	const cancelledRef = useRef(false);
	const acRef = useRef<AbortController | null>(null);
	const revokeRef = useRef<string[]>([]);

	useEffect(() => {
		cancelledRef.current = false;

		if (!fileUrl || !token) {
			setMediaUrl(null);
			setError(null);
			setLoading(false);
			return;
		}

		if (fileUrl.startsWith("blob:")) {
			setMediaUrl(fileUrl);
			setLoading(false);
			return;
		}

		setLoading(true);
		setError(null);

		const url = fileUrl;

		async function start() {
			const ac = new AbortController();
			acRef.current = ac;

			try {
				const headResp = await fetch(url, {
					headers: { Authorization: `Bearer ${token}` },
					method: "HEAD",
					signal: ac.signal,
				});

				const contentLength = parseInt(
					headResp.headers.get("Content-Length") || "0",
					10,
				);
				const contentType = headResp.headers.get("Content-Type") || "";
				const supportedMime = findSupportedMime(contentType);

				if (!supportedMime || contentLength === 0) {
					await loadAsBlob(url, ac.signal);
					return;
				}

				await loadViaMse(url, supportedMime, contentLength, ac.signal);
			} catch (err) {
				if (
					cancelledRef.current ||
					(err instanceof DOMException && err.name === "AbortError")
				) {
					return;
				}
				await loadAsBlob(url, ac.signal);
			}
		}

		async function loadAsBlob(
			loadUrl: string,
			signal?: AbortSignal,
		): Promise<void> {
			try {
				const resp = await fetch(loadUrl, {
					headers: { Authorization: `Bearer ${token}` },
					signal,
				});
				const blob = await resp.blob();
				const objectUrl = URL.createObjectURL(blob);
				revokeRef.current.push(objectUrl);

				if (!cancelledRef.current) {
					setMediaUrl(objectUrl);
					setLoading(false);
				}
			} catch (err) {
				if (
					cancelledRef.current ||
					(err instanceof DOMException && err.name === "AbortError")
				) {
					return;
				}
				setError(err instanceof Error ? err : new Error(String(err)));
				setLoading(false);
			}
		}

		async function loadViaMse(
			loadUrl: string,
			mime: string,
			totalBytes: number,
			signal: AbortSignal,
		): Promise<void> {
			const ms = new MediaSource();
			const blobUrl = URL.createObjectURL(ms);
			revokeRef.current.push(blobUrl);

			if (!cancelledRef.current) {
				setMediaUrl(blobUrl);
			}

			await new Promise<void>((resolve, reject) => {
				ms.addEventListener(
					"sourceopen",
					async () => {
						if (cancelledRef.current) {
							resolve();
							return;
						}

						try {
							const sb = ms.addSourceBuffer(mime);

							let offset = 0;

							const appendNext = async (): Promise<void> => {
								try {
									if (cancelledRef.current) {
										resolve();
										return;
									}

									if (offset >= totalBytes) {
										if (ms.readyState === "open") {
											try {
												ms.endOfStream();
											} catch {
												/* already ended */
											}
										}
										if (!cancelledRef.current) {
											setLoading(false);
										}
										resolve();
										return;
									}

									const end = Math.min(offset + CHUNK_SIZE - 1, totalBytes - 1);
									const resp = await fetch(loadUrl, {
										headers: {
											Authorization: `Bearer ${token}`,
											Range: `bytes=${offset}-${end}`,
										},
										signal,
									});
									const data = await resp.arrayBuffer();

									await new Promise<void>((res, rej) => {
										const errHandler = () =>
											rej(new Error("SourceBuffer error"));
										sb.addEventListener("error", errHandler, {
											once: true,
										});
										sb.addEventListener(
											"updateend",
											() => {
												sb.removeEventListener("error", errHandler);
												res();
											},
											{ once: true },
										);
										sb.appendBuffer(data);
									});

									offset = end + 1;
									await appendNext();
								} catch (err) {
									reject(err);
								}
							};

							appendNext();
						} catch (err) {
							reject(err);
						}
					},
					{ once: true },
				);
			});
		}

		start();

		return () => {
			cancelledRef.current = true;
			acRef.current?.abort();
			for (const u of revokeRef.current) {
				URL.revokeObjectURL(u);
			}
			revokeRef.current = [];
		};
	}, [fileUrl, token]);

	const isIdle = mediaUrl === null && error === null;

	return { mediaUrl, loading: isIdle || loading, error };
}
