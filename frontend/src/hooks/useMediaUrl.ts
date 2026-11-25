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
	// The object URL is stored with the request it belongs to: after a source
	// switch the old blob has already been revoked by the cleanup, and handing
	// it to the player would show a dead source instead of the loader.
	const [media, setMedia] = useState<{ source: string; url: string } | null>(
		null,
	);
	const [loading, setLoading] = useState(false);
	const [requestError, setRequestError] = useState<{
		source: string;
		error: Error;
	} | null>(null);

	const cancelledRef = useRef(false);
	const acRef = useRef<AbortController | null>(null);
	const revokeRef = useRef<string[]>([]);

	useEffect(() => {
		cancelledRef.current = false;

		if (!fileUrl || !token) {
			setMedia(null);
			setRequestError(null);
			setLoading(false);
			return;
		}

		if (fileUrl.startsWith("blob:")) {
			setMedia({ source: fileUrl, url: fileUrl });
			setRequestError(null);
			setLoading(false);
			return;
		}

		setLoading(true);
		setRequestError(null);

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
					setMedia({ source: loadUrl, url: objectUrl });
					setLoading(false);
				}
			} catch (err) {
				if (
					cancelledRef.current ||
					(err instanceof DOMException && err.name === "AbortError")
				) {
					return;
				}
				setRequestError({
					source: loadUrl,
					error: err instanceof Error ? err : new Error(String(err)),
				});
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
				setMedia({ source: loadUrl, url: blobUrl });
			}

			await new Promise<void>((resolve, reject) => {
				ms.addEventListener(
					"sourceopen",
					() => {
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
									reject(err instanceof Error ? err : new Error(String(err)));
								}
							};

							void appendNext();
						} catch (err) {
							reject(err instanceof Error ? err : new Error(String(err)));
						}
					},
					{ once: true },
				);
			});
		}

		void start();

		return () => {
			cancelledRef.current = true;
			acRef.current?.abort();
			for (const u of revokeRef.current) {
				URL.revokeObjectURL(u);
			}
			revokeRef.current = [];
		};
	}, [fileUrl, token]);

	const mediaUrl =
		media !== null && media.source === fileUrl ? media.url : null;
	const error =
		requestError !== null && requestError.source === fileUrl
			? requestError.error
			: null;
	const isIdle = mediaUrl === null && error === null;

	return { mediaUrl, loading: isIdle || loading, error };
}
