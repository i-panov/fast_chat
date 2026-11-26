import { useEffect, useState } from "react";
import { getActiveAccountKey } from "../db/init.ts";
import type { FileKey } from "../e2ee/file-crypto.ts";
import { decryptFileStream } from "../e2ee/file-crypto.ts";
import type { FileInfo } from "../types/api.ts";
import { registerBlobUrl, releaseBlobUrl } from "../utils/blobUrlRefs.ts";
import {
	cacheDecryptedFile,
	decryptedCacheKey,
	getCachedDecryptedFile,
} from "../utils/fileCache.ts";
import { useFileUrl } from "./useFileUrl.ts";

// The key is matched by file hash first, then by file id. Returns undefined
// for plaintext files.
function fileKeyFor(
	file: FileInfo | undefined,
	fileKeys: Record<string, FileKey> | undefined,
): FileKey | undefined {
	if (file === undefined) return;
	return (
		(file.hash !== undefined ? fileKeys?.[file.hash] : undefined) ??
		fileKeys?.[file.id]
	);
}

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
	// cacheChecked tells whether the plaintext cache lookup has finished. A
	// failed ciphertext request must not surface before the cache had its
	// chance: the plaintext may already be stored and the ciphertext evicted.
	const [cacheChecked, setCacheChecked] = useState(false);

	const key = fileKeyFor(file, fileKeys);
	const localPlaintext = file?.url.startsWith("blob:") === true;

	useEffect(() => {
		setDecryptError(null);
		if (!file) {
			setDecryptedUrl(null);
			return;
		}

		const fileKey = fileKeyFor(file, fileKeys);
		// A local blob URL is the plaintext of an attachment that is still
		// being sent (or failed to). It already is the file, and it belongs to
		// an encrypted message, so a key for its hash exists: decrypting the
		// local bytes fails and the bubble shows "could not load image" until
		// the server copy replaces the row.
		const localBytes = file.url.startsWith("blob:");
		if (fileKey === undefined || localBytes) {
			// No key: file is plaintext.
			setDecryptedUrl(encryptedUrl ?? null);
			return;
		}

		setCacheChecked(false);
		let cancelled = false;
		let createdUrl: string | null = null;
		// The account can change while the request is in flight. The write
		// must land in the database of the account that requested it: a
		// late write would persist one account's plaintext in another's
		// IndexedDB, where it survives the first account's logout.
		const accountKey = getActiveAccountKey();
		const cacheKey = decryptedCacheKey(file.url, fileKey, file.hash ?? file.id);

		void (async () => {
			try {
				const cached = await getCachedDecryptedFile(cacheKey);
				if (getActiveAccountKey() !== accountKey) return;
				if (!cancelled) setCacheChecked(true);
				if (cached !== undefined) {
					createdUrl = URL.createObjectURL(cached);
					registerBlobUrl(createdUrl);
					if (cancelled) {
						releaseBlobUrl(createdUrl);
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
				const plain = await decryptFileStream(ciphertext, fileKey);
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
				registerBlobUrl(createdUrl);
				if (cancelled) {
					// The cleanup already ran with createdUrl === null:
					// release here so the late URL does not leak.
					releaseBlobUrl(createdUrl);
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
			if (createdUrl) {
				releaseBlobUrl(createdUrl);
				createdUrl = null;
			}
		};
	}, [file, fileKeys, encryptedUrl]);

	const resolved = file ? decryptedUrl : null;
	// A key with no plaintext yet means decryption is still running (or the
	// ciphertext request or cache lookup has not settled). Report it as
	// loading: the gap between the ciphertext arriving and the decrypted blob
	// being created is otherwise rendered as a load error for a frame, and for
	// large media it can last noticeably long. While the plaintext cache is
	// still being read, a failed ciphertext request must not win either: the
	// cache may already hold the file.
	const awaitingPlaintext =
		file !== undefined &&
		key !== undefined &&
		!localPlaintext &&
		resolved === null &&
		decryptError === null &&
		(!cacheChecked || error === null);
	const pending = awaitingPlaintext || (loading && resolved === null);

	return {
		blobUrl: resolved,
		loading: pending,
		// A cached plaintext makes a failed ciphertext request irrelevant:
		// the attachment is displayable, so do not report an error for it.
		error: resolved !== null || pending ? null : (error ?? decryptError),
	};
}
