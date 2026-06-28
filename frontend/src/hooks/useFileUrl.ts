import { useEffect, useState } from "react";
import { acquireFileBlobUrl, releaseFileBlobUrl } from "../utils/fileCache.ts";

export function useFileUrl(
	fileUrl: string | undefined,
	token: string | undefined,
): { blobUrl: string | null; loading: boolean; error: Error | null } {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		if (!fileUrl) {
			setBlobUrl(null);
			setError(null);
			return;
		}

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

	const loading = blobUrl === null && error === null;

	return { blobUrl, loading, error };
}
