import { useEffect, useState } from "react";
import { getActiveAccountKey } from "../db/init.ts";
import type { FileKey } from "../e2ee/file-crypto.ts";
import { decryptFileStream } from "../e2ee/file-crypto.ts";
import {
	getLockEpoch,
	isLocalLockConfigured,
	isLocalLockUnlocked,
} from "../e2ee/keys.ts";
import type { FileInfo } from "../types/api.ts";
import { registerBlobUrl, releaseBlobUrl } from "../utils/blobUrlRefs.ts";
import {
	cacheDecryptedFile,
	decryptedCacheKey,
	getCachedDecryptedFile,
	removeCachedDecryptedFile,
} from "../utils/fileCache.ts";
import { useFileUrl } from "./useFileUrl.ts";
import { useLocalLockRevision } from "./useLocalLockRevision.ts";

// A file above this size is not decrypted in one piece: both the ciphertext
// and the plaintext would live in memory and the synchronous libsodium call
// would freeze the page. Streaming/worker decryption is a separate task; a
// clear error beats an out-of-memory crash on a phone.
const MAX_IN_MEMORY_DECRYPT_BYTES = 256 * 1024 * 1024;

function isLockClosed(): boolean {
	return isLocalLockConfigured() === true && !isLocalLockUnlocked();
}

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

interface DecryptJob {
	encryptedUrl: string;
	fileKey: FileKey;
	mime: string;
	cacheKey: string;
	accountKey: string | null;
	epoch: number;
	signal: AbortSignal;
	isCancelled: () => boolean;
}

// decryptIntoBlobUrl downloads the ciphertext, decrypts it and caches the
// plaintext. It returns null when the request became stale (a lock, an
// account switch or an unmount): no URL is created after that, so the caller
// does not have to release a leaked blob.
async function decryptIntoBlobUrl(job: DecryptJob): Promise<string | null> {
	const resp = await fetch(job.encryptedUrl, { signal: job.signal });
	if (!resp.ok) {
		throw new Error(`Failed to load file: ${resp.status}`);
	}
	const blob = await resp.blob();
	if (blob.size > MAX_IN_MEMORY_DECRYPT_BYTES) {
		throw new Error(
			`File is too large to decrypt in memory: ${blob.size} bytes`,
		);
	}
	const ciphertext = new Uint8Array(await blob.arrayBuffer());
	const plain = await decryptFileStream(ciphertext, job.fileKey);
	if (getActiveAccountKey() !== job.accountKey) return null;
	// The lock may have closed while the stream was decrypting; cleanup runs
	// before the next effect, so a stale job must not cache or show anything.
	if (job.isCancelled() || isLockClosed() || getLockEpoch() !== job.epoch) {
		return null;
	}

	const plainBlob = new Blob([plain as unknown as ArrayBuffer], {
		type: job.mime,
	});

	try {
		// The bytes are already in memory: do not copy them into a second
		// ArrayBuffer for the cache.
		await cacheDecryptedFile(
			job.cacheKey,
			plainBlob,
			job.accountKey,
			plain.buffer as ArrayBuffer,
		);
	} catch {
		// Quota or a blocked database: showing the file still wins.
	}
	if (job.isCancelled() || isLockClosed() || getLockEpoch() !== job.epoch) {
		// The plaintext was written before the lock/cleanup could run; remove
		// it so it does not stay on disk.
		await removeCachedDecryptedFile(job.cacheKey);

		return null;
	}
	if (job.isCancelled()) return null;

	const url = URL.createObjectURL(plainBlob);
	registerBlobUrl(url);

	return url;
}

function matchingUrl(
	state: { identity: string; url: string } | null,
	identity: string | null,
): string | null {
	return state !== null && state.identity === identity ? state.url : null;
}

function matchingError(
	state: { identity: string; error: Error } | null,
	identity: string | null,
): Error | null {
	return state !== null && state.identity === identity ? state.error : null;
}

// shouldRequestCiphertext is true when the plaintext is not local, there is a
// key, and the cache lookup already missed (or there is no key at all: a
// plaintext file needs its blob too).
function shouldRequestCiphertext(args: {
	identity: string | null;
	locked: boolean;
	localPlaintext: boolean;
	keyed: boolean;
	missedIdentity: string | null;
}): boolean {
	if (args.identity === null || args.locked || args.localPlaintext)
		return false;
	return !args.keyed || args.missedIdentity === args.identity;
}

function computePending(args: {
	identity: string | null;
	localPlaintext: boolean;
	keyed: boolean;
	resolved: string | null;
	error: Error | null;
	missedIdentity: string | null;
	encryptedLoading: boolean;
}): boolean {
	if (args.identity === null) return false;
	if (args.encryptedLoading && args.resolved === null && args.error === null) {
		return true;
	}
	if (!args.keyed || args.localPlaintext) return false;

	const cacheSettled =
		args.missedIdentity === args.identity || args.resolved !== null;
	return args.resolved === null && args.error === null && !cacheSettled;
}

function pickVisibleError(
	resolved: string | null,
	pending: boolean,
	encryptedError: Error | null,
	decryptError: Error | null,
): Error | null {
	return resolved !== null || pending ? null : (encryptedError ?? decryptError);
}

// useDecryptedFileUrl fetches a file and, if a decryption key exists for it,
// decrypts the blob before returning the object URL. The key is matched by
// file hash first, then by file id: id-keyed files (e.g. legacy uploads
// without a hash) must not fall through to plaintext. Files without any key
// are returned as-is (plaintext).
//
// The decrypted blob is cached in the account's IndexedDB: a second view (or
// a restart) does not download and decrypt the same file again. The plaintext
// cache is checked first: the ciphertext request starts only when the cache
// misses, so a cached file is shown without a redundant download.
export function useDecryptedFileUrl(
	file: FileInfo | undefined,
	fileKeys: Record<string, FileKey> | undefined,
	token: string | undefined,
): { blobUrl: string | null; loading: boolean; error: Error | null } {
	const key = fileKeyFor(file, fileKeys);
	const lockRevision = useLocalLockRevision();

	const fileUrl = file?.url;
	const fileHash = file?.hash;
	const fileId = file?.id;
	const fileMime = file?.mimeType;
	const keyValue = key?.key;
	const keyNonce = key?.nonce;
	const localPlaintext = fileUrl?.startsWith("blob:") === true;

	// The identity names the exact request: a URL of another file, another
	// key or another account must not be handed to the interface.
	const identity =
		fileUrl === undefined
			? null
			: `${fileUrl}|${fileHash ?? ""}|${fileId ?? ""}|${keyValue ?? ""}|${keyNonce ?? ""}|${token ?? ""}|${lockRevision}`;

	// plaintextMiss is the identity whose plaintext cache lookup missed: only
	// then the ciphertext is requested. A cache hit never downloads anything.
	const [plaintextMiss, setPlaintextMiss] = useState<string | null>(null);
	const [decrypted, setDecrypted] = useState<{
		identity: string;
		url: string;
	} | null>(null);
	const [decryptError, setDecryptError] = useState<{
		identity: string;
		error: Error;
	} | null>(null);

	const shouldFetchCiphertext = shouldRequestCiphertext({
		identity,
		locked: isLockClosed(),
		localPlaintext,
		keyed: keyValue !== undefined,
		missedIdentity: plaintextMiss,
	});

	const {
		blobUrl: encryptedUrl,
		loading: encryptedLoading,
		error: encryptedError,
	} = useFileUrl(shouldFetchCiphertext ? fileUrl : undefined, token);

	useEffect(() => {
		if (identity === null) {
			setDecrypted(null);
			return;
		}

		if (isLockClosed()) {
			setDecrypted(null);
			return;
		}

		setDecryptError(null);

		// A local blob URL is the plaintext of an attachment that is still
		// being sent (or failed to). It already is the file, and it belongs to
		// an encrypted message, so a key for its hash exists: decrypting the
		// local bytes fails and the bubble shows "could not load image" until
		// the server copy replaces the row.
		if (localPlaintext) {
			if (fileUrl !== undefined) {
				setDecrypted({ identity, url: fileUrl });
			}

			return;
		}

		// No key: the file is plaintext. Its blob URL comes from the
		// ciphertext hook; handing the server URL out directly would skip the
		// Authorization header.
		if (keyValue === undefined) {
			if (encryptedUrl) {
				setDecrypted({ identity, url: encryptedUrl });
			}

			return;
		}

		let cancelled = false;
		let createdUrl: string | null = null;
		const abort = new AbortController();
		// The account can change while the request is in flight. The write
		// must land in the database of the account that requested it: a
		// late write would persist one account's plaintext in another's
		// IndexedDB, where it survives the first account's logout.
		const accountKey = getActiveAccountKey();
		const epoch = getLockEpoch();
		const fileKey: FileKey = { key: keyValue, nonce: keyNonce ?? "" };
		const sourceUrl = fileUrl;
		const fileRef = fileHash ?? fileId;
		if (sourceUrl === undefined || fileRef === undefined) return;
		const cacheKey = decryptedCacheKey(sourceUrl, fileKey, fileRef);
		const currentIdentity = identity;

		void (async () => {
			try {
				// The plaintext cache comes first: the ciphertext copy may
				// already be evicted, and a hit must not trigger a download.
				if (plaintextMiss !== currentIdentity) {
					const cached = await getCachedDecryptedFile(cacheKey);
					if (getActiveAccountKey() !== accountKey) return;
					if (cancelled || isLockClosed() || getLockEpoch() !== epoch) {
						return;
					}

					if (cached !== undefined) {
						createdUrl = URL.createObjectURL(cached);
						registerBlobUrl(createdUrl);
						if (cancelled) {
							releaseBlobUrl(createdUrl);
							createdUrl = null;
							return;
						}
						setDecrypted({ identity: currentIdentity, url: createdUrl });
						return;
					}

					// The lookup missed: the next run may request the
					// ciphertext.
					setPlaintextMiss(currentIdentity);
					return;
				}

				if (!encryptedUrl) return;

				const url = await decryptIntoBlobUrl({
					encryptedUrl,
					fileKey,
					mime: fileMime ?? "",
					cacheKey,
					accountKey,
					epoch,
					signal: abort.signal,
					isCancelled: () => cancelled,
				});
				if (url === null) return;
				if (cancelled) {
					// The cleanup already ran with createdUrl === null:
					// release here so the late URL does not leak.
					releaseBlobUrl(url);

					return;
				}

				createdUrl = url;
				setDecrypted({ identity: currentIdentity, url });
			} catch (err) {
				if (cancelled || abort.signal.aborted) return;
				// Never hand ciphertext out as the file: surface the failure
				// so the UI shows an error instead of a corrupt download.
				setDecryptError({
					identity: currentIdentity,
					error: err instanceof Error ? err : new Error(String(err)),
				});
				setDecrypted(null);
			}
		})();

		return () => {
			cancelled = true;
			abort.abort();
			if (createdUrl) {
				releaseBlobUrl(createdUrl);
				createdUrl = null;
			}
		};
	}, [
		identity,
		fileUrl,
		fileHash,
		fileId,
		fileMime,
		keyValue,
		keyNonce,
		localPlaintext,
		plaintextMiss,
		encryptedUrl,
	]);

	const resolved = matchingUrl(decrypted, identity);
	const currentError = matchingError(decryptError, identity);
	const pending = computePending({
		identity,
		localPlaintext,
		keyed: keyValue !== undefined,
		resolved,
		error: currentError,
		missedIdentity: plaintextMiss,
		encryptedLoading,
	});

	return {
		blobUrl: resolved,
		loading: pending,
		// A cached plaintext makes a failed ciphertext request irrelevant:
		// the attachment is displayable, so do not report an error for it.
		error: pickVisibleError(resolved, pending, encryptedError, currentError),
	};
}
