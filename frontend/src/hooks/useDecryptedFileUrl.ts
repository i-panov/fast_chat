import { useEffect, useState } from "react";
import { getActiveAccountKey } from "../db/init.ts";
import type { FileKey } from "../e2ee/file-crypto.ts";
import { decryptFileStream } from "../e2ee/file-crypto.ts";
import type { FileInfo } from "../types/api.ts";
import {
	cacheDecryptedFile,
	decryptedCacheKey,
	getCachedDecryptedFile,
} from "../utils/fileCache.ts";
import { useFileUrl } from "./useFileUrl.ts";

// useDecryptedFileUrl fetches a file and, if a decryption key exists for it,
// decrypts the blob before returning the object URL. The key is matched by
// file hash first, then by file id: id-keyed files (e.g. legacy uploads
// without a hash) must not fall through to plaintext. Files without any key
// are returned as-is (plaintext).
//
// The decrypted blob is cached in the account's IndexedDB: a second view (or
// a restart) does not download and decrypt the same file again. The lookup
// runs before the ciphertext request, so the cached plaintext is enough on
// its own; the ciphertext copy may already be evicted.
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
		if (!file) {
			setDecryptedUrl(null);
			return;
		}

		const key =
			(file.hash !== undefined ? fileKeys?.[file.hash] : undefined) ??
			fileKeys?.[file.id];
		// A local blob URL is the plaintext of an attachment that is still
		// being sent (or failed to). It already is the file, and it belongs to
		// an encrypted message, so a key for its hash exists: decrypting the
		// local bytes fails and the bubble shows "could not load image" until
		// the server copy replaces the row.
		const localPlaintext = file.url.startsWith("blob:");
		if (key === undefined || localPlaintext) {
			// No key: file is plaintext.
			setDecryptedUrl(encryptedUrl ?? null);
			return;
		}

		let cancelled = false;
		let createdUrl: string | null = null;
		// The account can change while the request is in flight. The write
		// must land in the database of the account that requested it: a
		// late write would persist one account's plaintext in another's
		// IndexedDB, where it survives the first account's logout.
		const accountKey = getActiveAccountKey();
		const cacheKey = decryptedCacheKey(file.url, key, file.hash ?? file.id);

		void (async () => {
			try {
				const cached = await getCachedDecryptedFile(cacheKey);
				if (getActiveAccountKey() !== accountKey) return;
				if (cached !== undefined) {
					createdUrl = URL.createObjectURL(cached);
					if (cancelled) {
						URL.revokeObjectURL(createdUrl);
						createdUrl = null;
						return;
					}
					setDecryptedUrl(createdUrl);
					return;
				}

				// The ciphertext URL is produced by useFileUrl; wait for it
				// when there is no cached plaintext yet.
				if (!encryptedUrl) return;

				const resp = await fetch(encryptedUrl);
				const blob = await resp.blob();
				const ciphertext = new Uint8Array(await blob.arrayBuffer());
				const plain = await decryptFileStream(ciphertext, key);
				const plainBlob = new Blob([plain as unknown as ArrayBuffer], {
					type: file.mimeType,
				});
				if (getActiveAccountKey() !== accountKey) return;

				try {
					await cacheDecryptedFile(cacheKey, plainBlob, accountKey);
				} catch {
					// Quota or a blocked database: showing the file still wins.
				}

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

	const resolved = file ? decryptedUrl : null;

	return {
		blobUrl: resolved,
		loading: loading && resolved === null,
		// A cached plaintext makes a failed ciphertext request irrelevant:
		// the attachment is displayable, so do not report an error for it.
		error: resolved !== null ? null : (error ?? decryptError),
	};
}
