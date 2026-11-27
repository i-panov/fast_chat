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

// fetchMediaBlobUrl downloads the file and returns an object URL of its
// bytes. It never creates a URL after the request was cancelled: the cleanup
// of the hook has already revoked everything it knew about.
async function fetchMediaBlobUrl(
	url: string,
	token: string,
	signal: AbortSignal | undefined,
	isCancelled: () => boolean,
): Promise<string | null> {
	const resp = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal,
	});
	if (!resp.ok) {
		throw new Error(`Failed to load media: ${resp.status}`);
	}
	const blob = await resp.blob();
	if (isCancelled()) return null;

	const objectUrl = URL.createObjectURL(blob);
	if (isCancelled()) {
		URL.revokeObjectURL(objectUrl);

		return null;
	}

	return objectUrl;
}

function isAbort(error: unknown, cancelled: boolean): boolean {
	return (
		cancelled || (error instanceof DOMException && error.name === "AbortError")
	);
}

interface MseHooks {
	isCancelled: () => boolean;
	// onSource owns tracking and revoking of the MediaSource object URL.
	onSource: (url: string) => void;
	onDone: () => void;
}

async function streamMedia(
	loadUrl: string,
	mime: string,
	totalBytes: number,
	token: string,
	signal: AbortSignal,
	hooks: MseHooks,
): Promise<void> {
	const ms = new MediaSource();
	const blobUrl = URL.createObjectURL(ms);
	if (hooks.isCancelled()) {
		URL.revokeObjectURL(blobUrl);
		return;
	}
	hooks.onSource(blobUrl);

	await new Promise<void>((resolve, reject) => {
		ms.addEventListener(
			"sourceopen",
			() => {
				if (hooks.isCancelled()) {
					resolve();
					return;
				}

				try {
					const sb = ms.addSourceBuffer(mime);

					let offset = 0;

					const appendNext = async (): Promise<void> => {
						try {
							if (hooks.isCancelled()) {
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
								if (!hooks.isCancelled()) {
									hooks.onDone();
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

							// A server that ignores Range answers 200 with the
							// whole body: appending it as a chunk corrupts the
							// stream. Fall back to a plain blob download.
							if (resp.status !== 206) {
								throw new Error(
									`The server ignored the range request: ${resp.status}`,
								);
							}
							const contentRange = resp.headers.get("Content-Range");
							if (
								contentRange !== null &&
								!contentRange.startsWith(`bytes ${offset}-`)
							) {
								throw new Error(`Unexpected Content-Range: ${contentRange}`);
							}
							const data = await resp.arrayBuffer();

							await new Promise<void>((res, rej) => {
								const errHandler = () => rej(new Error("SourceBuffer error"));
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
		const authToken = token;

		async function start() {
			const ac = new AbortController();
			acRef.current = ac;

			try {
				const headResp = await fetch(url, {
					headers: { Authorization: `Bearer ${token}` },
					method: "HEAD",
					signal: ac.signal,
				});

				// A 401/403/404 body is JSON or HTML, not media: wrapping it
				// in a blob URL would hand a broken source to the player.
				if (!headResp.ok) {
					throw new Error(`Failed to load media: ${headResp.status}`);
				}

				const contentLength = Number(
					headResp.headers.get("Content-Length") ?? "0",
				);
				const contentType = headResp.headers.get("Content-Type") ?? "";
				const supportedMime = findSupportedMime(contentType);

				if (supportedMime && contentLength > 0) {
					await loadViaMse(url, supportedMime, contentLength, ac.signal);
				} else {
					await loadAsBlob(url, ac.signal);
				}
			} catch (err) {
				if (isAbort(err, cancelledRef.current)) {
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
				const objectUrl = await fetchMediaBlobUrl(
					loadUrl,
					authToken,
					signal,
					() => cancelledRef.current,
				);
				if (objectUrl === null) return;

				revokeRef.current.push(objectUrl);
				setMedia({ source: loadUrl, url: objectUrl });
				setLoading(false);
			} catch (err) {
				if (isAbort(err, cancelledRef.current)) return;
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
			await streamMedia(loadUrl, mime, totalBytes, authToken, signal, {
				isCancelled: () => cancelledRef.current,
				onSource: (url) => setMedia({ source: loadUrl, url }),
				onDone: () => setLoading(false),
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
	// Without a source there is nothing to load: a spinner that never ends
	// is worse than an empty state.
	return {
		mediaUrl,
		loading:
			fileUrl !== undefined &&
			token !== undefined &&
			((mediaUrl === null && error === null) || loading),
		error,
	};
}
