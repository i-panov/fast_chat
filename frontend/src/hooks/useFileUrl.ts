import { useEffect, useState } from "react";
import { acquireFileBlobUrl, releaseFileBlobUrl } from "../utils/fileCache.ts";

export function useFileUrl(
	fileUrl: string | undefined,
	token: string | undefined,
): { blobUrl: string | null; loading: boolean; error: Error | null } {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		// Reset stale state first so a fileUrl switch never shows the
		// previous file's blob or error while the new one resolves.
		setBlobUrl(null);
		setError(null);
		if (!fileUrl) return;

		let cancelled = false;

		acquireFileBlobUrl(fileUrl, token)
			.then((url) => {
				if (!cancelled) {
					setBlobUrl(url);
					setError(null);
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setError(err instanceof Error ? err : new Error(String(err)));
				}
			});

		return () => {
			cancelled = true;
			releaseFileBlobUrl(fileUrl);
		};
	}, [fileUrl, token]);

	const effectiveBlobUrl = fileUrl ? blobUrl : null;
	const effectiveError = fileUrl ? error : null;
	const loading = effectiveBlobUrl === null && effectiveError === null;

	return { blobUrl: effectiveBlobUrl, loading, error: effectiveError };
}
