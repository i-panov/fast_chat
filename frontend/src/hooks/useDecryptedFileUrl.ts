import { useEffect, useState } from "react";
import type { FileKey } from "../e2ee/file-crypto.ts";
import { decryptFileStream } from "../e2ee/file-crypto.ts";
import type { FileInfo } from "../types/api.ts";
import { useFileUrl } from "./useFileUrl.ts";

// useDecryptedFileUrl fetches a file and, if a decryption key exists for it
// (matched by file ID), decrypts the blob before returning the object URL.
// Files without a key are returned as-is (plaintext).
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

	useEffect(() => {
		if (!file || !encryptedUrl) {
			setDecryptedUrl(null);
			return;
		}

		const key = fileKeys?.[file.hash ?? ""];
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

				if (!cancelled) {
					setDecryptedUrl(createdUrl);
				}
			} catch (err) {
				if (cancelled) return;
				// On decryption failure, fall back to the encrypted URL so the
				// user can still download (they'll get ciphertext, but no crash).
				setDecryptedUrl(encryptedUrl);
				console.error("Failed to decrypt file:", err);
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
		error,
	};
}
