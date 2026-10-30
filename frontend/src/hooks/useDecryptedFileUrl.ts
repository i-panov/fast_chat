import { useEffect, useState } from "react";
import type { FileKey } from "../e2ee/file-crypto.ts";
import { decryptFileStream } from "../e2ee/file-crypto.ts";
import type { FileInfo } from "../types/api.ts";
import { useFileUrl } from "./useFileUrl.ts";

// useDecryptedFileUrl fetches a file and, if a decryption key exists for it,
// decrypts the blob before returning the object URL. The key is matched by
// file hash first, then by file id: id-keyed files (e.g. legacy uploads
// without a hash) must not fall through to plaintext. Files without any key
// are returned as-is (plaintext).
export function useDecryptedFileUrl(
	file: FileInfo | undefined,
	fileKeys: Record<string, FileKey> | undefined,
	token: string | undefined,
): { blobUrl: string | null; loading: boolean; error: Error | null } {
	const {
		blobUrl: encryptedUrl,
		loading,
		error,
	} = useFileUrl(file?.url, token);
	const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);
	const [decryptError, setDecryptError] = useState<Error | null>(null);

	useEffect(() => {
		setDecryptError(null);
		if (!file || !encryptedUrl) {
			setDecryptedUrl(null);
			return;
		}

		const key =
			(file.hash !== undefined ? fileKeys?.[file.hash] : undefined) ??
			fileKeys?.[file.id];
		if (key === undefined) {
			// No key: file is plaintext.
			setDecryptedUrl(encryptedUrl);
			return;
		}

		let cancelled = false;
		let createdUrl: string | null = null;

		void (async () => {
			try {
				const resp = await fetch(encryptedUrl);
				const blob = await resp.blob();
				const ciphertext = new Uint8Array(await blob.arrayBuffer());
				const plain = await decryptFileStream(ciphertext, key);
				const plainBlob = new Blob([plain as unknown as ArrayBuffer], {
					type: file.mimeType,
				});
				createdUrl = URL.createObjectURL(plainBlob);

				if (cancelled) {
					// The cleanup already ran with createdUrl === null: revoke
					// here so the late URL does not leak.
					URL.revokeObjectURL(createdUrl);
					createdUrl = null;
				} else {
					setDecryptedUrl(createdUrl);
				}
			} catch (err) {
				if (cancelled) return;
				// Never hand ciphertext out as the file: surface the failure
				// so the UI shows an error instead of a corrupt download.
				setDecryptError(err instanceof Error ? err : new Error(String(err)));
				setDecryptedUrl(null);
			}
		})();

		return () => {
			cancelled = true;
			if (createdUrl) URL.revokeObjectURL(createdUrl);
		};
	}, [file, fileKeys, encryptedUrl]);

	return {
		blobUrl: file ? decryptedUrl : null,
		loading,
		error: error ?? decryptError,
	};
}
