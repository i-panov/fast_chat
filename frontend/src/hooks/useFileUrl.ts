import { useEffect, useState } from "react";
import { acquireFileBlobUrl, releaseFileBlobUrl } from "../utils/fileCache.ts";

// The URL is stored with the request it belongs to. After a source switch the
// old blob has already been revoked by the cleanup, and the first render of
// the new source must not hand it to the interface: the avatar or the
// lightbox would briefly show the previous file (or a dead URL).
interface ResolvedFileUrl {
	source: string;
	token: string | undefined;
	url: string;
}

export function useFileUrl(
	fileUrl: string | undefined,
	token: string | undefined,
): { blobUrl: string | null; loading: boolean; error: Error | null } {
	const [resolved, setResolved] = useState<ResolvedFileUrl | null>(null);
	const [failure, setFailure] = useState<{
		source: string;
		token: string | undefined;
		error: Error;
	} | null>(null);

	useEffect(() => {
		if (!fileUrl) return;

		let cancelled = false;

		acquireFileBlobUrl(fileUrl, token)
			.then((url) => {
				if (!cancelled) {
					setResolved({ source: fileUrl, token, url });
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setFailure({
						source: fileUrl,
						token,
						error: err instanceof Error ? err : new Error(String(err)),
					});
				}
			});

		return () => {
			cancelled = true;
			releaseFileBlobUrl(fileUrl);
		};
	}, [fileUrl, token]);

	const current =
		resolved !== null &&
		resolved.source === fileUrl &&
		resolved.token === token;
	const currentFailure =
		failure !== null && failure.source === fileUrl && failure.token === token
			? failure.error
			: null;
	const blobUrl = fileUrl && current ? (resolved?.url ?? null) : null;
	const error = fileUrl ? currentFailure : null;

	// Without a source there is nothing to load: reporting "loading" forever
	// would leave the attachment on a spinner.
	const loading = fileUrl !== undefined && blobUrl === null && error === null;

	return { blobUrl, loading, error };
}
