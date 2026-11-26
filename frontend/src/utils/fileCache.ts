import { decryptedFilesRepo } from "../db/decryptedFilesRepo.ts";
import { fileCacheRepo } from "../db/fileCacheRepo.ts";
import { getActiveAccountKey } from "../db/init.ts";

const inMemoryCache = new Map<
	string,
	{
		blobUrl: string;
		refCount: number;
		promise: Promise<string>;
		rawUrl: string;
	}
>();

function getToken(): string | undefined {
	try {
		return sessionStorage.getItem("activeToken") ?? undefined;
	} catch {
		return;
	}
}

function scopeKey(fileUrl: string): string {
	// Scope by account only, never by token: tokens rotate (refresh), and
	// a token-scoped key would orphan live entries on every rotation —
	// leaking their blob URLs until the next switch/logout while the same
	// file is fetched from the network again.
	const acct = getActiveAccountKey() ?? "anon";
	return `${acct}::${fileUrl}`;
}

export function clearFileCache(): void {
	for (const entry of inMemoryCache.values()) {
		if (entry.blobUrl) {
			try {
				URL.revokeObjectURL(entry.blobUrl);
			} catch {
				// best effort
			}
		}
	}
	inMemoryCache.clear();
}

export function acquireFileBlobUrl(
	fileUrl: string,
	token?: string,
): Promise<string> {
	if (fileUrl.startsWith("blob:")) return Promise.resolve(fileUrl);

	const key = scopeKey(fileUrl);
	const existing = inMemoryCache.get(key);
	if (existing) {
		existing.refCount++;
		return existing.promise;
	}

	const promise = loadFile(key, fileUrl, token);
	inMemoryCache.set(key, {
		blobUrl: "",
		refCount: 1,
		promise,
		rawUrl: fileUrl,
	});
	return promise;
}

export function releaseFileBlobUrl(fileUrl: string): void {
	if (fileUrl.startsWith("blob:")) return;

	// Strictly scoped release: falling back to another account's entry by
	// raw URL would revoke a foreign blob out from under its owner (and
	// leak ours). A miss (e.g. after clearFileCache on switch) is normal.
	const entry = inMemoryCache.get(scopeKey(fileUrl));
	if (!entry) return;
	entry.refCount--;
	if (entry.refCount <= 0) {
		if (entry.blobUrl) {
			URL.revokeObjectURL(entry.blobUrl);
		}
		for (const [k, v] of inMemoryCache) {
			if (v === entry) inMemoryCache.delete(k);
		}
	}
}

export function isFileCached(fileUrl: string): Promise<boolean> {
	return fileCacheRepo.isCached(fileUrl);
}

// Decrypted attachments are cached under a key of their own: the ciphertext
// entry stays keyed by the URL (that is what isFileCached and downloads
// check), while the plaintext is only reachable with the file key. The key
// material is part of the cache key, so a rotated file key never serves
// content decrypted with the old one. The database is per-account and is
// deleted with the account on logout.
const DECRYPTED_PREFIX = "decrypted:";

export function decryptedCacheKey(
	fileUrl: string,
	fileKey: { key: string },
	fileID: string,
): string {
	return `${DECRYPTED_PREFIX}${fileUrl}:${fileID}:${fileKey.key}`;
}

export async function getCachedDecryptedFile(
	cacheKey: string,
): Promise<Blob | undefined> {
	const cached = await decryptedFilesRepo.get(cacheKey);
	if (cached === undefined) return;

	return new Blob([cached.bytes], { type: cached.mimeType });
}

export async function cacheDecryptedFile(
	cacheKey: string,
	blob: Blob,
	accountKey: string | null = getActiveAccountKey(),
): Promise<void> {
	// The repository applies the size and quota limits; a full disk must not
	// break the display of a file that is already decrypted in memory. The
	// account key is passed explicitly so the write is bound to the account
	// that started the request, not the one that happens to be active after
	// the decrypt.
	const bytes = await blob.arrayBuffer();
	await decryptedFilesRepo.put(cacheKey, bytes, blob.type, accountKey);
}

// saveFileOffline downloads the file even when it is above the automatic
// cache threshold. The caller must pass the account token.
export async function saveFileOffline(
	fileUrl: string,
	token: string | undefined,
): Promise<void> {
	const accountKey = getActiveAccountKey();
	if (await fileCacheRepo.isCached(fileUrl)) return;
	void navigator.storage?.persist?.().catch(() => false);

	const headers: Record<string, string> = {};
	if (token !== undefined) headers.Authorization = `Bearer ${token}`;
	const response = await fetch(fileUrl, { headers });
	if (!response.ok) throw new Error(`Failed to load file: ${response.status}`);
	const blob = await response.blob();
	if (getActiveAccountKey() !== accountKey) {
		throw new Error("account changed while saving the file");
	}
	const stored = await fileCacheRepo.put(fileUrl, blob, blob.type, true);
	if (!stored) {
		throw new Error("file is too large for the offline cache");
	}
}

async function loadFile(
	key: string,
	fileUrl: string,
	token?: string,
): Promise<string> {
	const accountKey = getActiveAccountKey();
	// Try IDB cache first (the IDB itself is per-account).
	const cached = await fileCacheRepo.get(fileUrl);
	if (getActiveAccountKey() !== accountKey) {
		throw new Error("account changed while loading the file");
	}
	if (cached !== undefined) {
		const blobUrl = URL.createObjectURL(cached.blob);
		const entry = inMemoryCache.get(key);
		if (entry) {
			entry.blobUrl = blobUrl;
		}
		return blobUrl;
	}

	const tok = token ?? getToken();
	const headers: Record<string, string> = {};
	if (tok) {
		headers.Authorization = `Bearer ${tok}`;
	}
	const resp = await fetch(fileUrl, { headers });
	if (!resp.ok) {
		throw new Error(`Failed to load file: ${resp.status}`);
	}
	const blob = await resp.blob();
	const blobUrl = URL.createObjectURL(blob);

	const entry = inMemoryCache.get(key);
	if (!entry) {
		URL.revokeObjectURL(blobUrl);
		throw new Error("File request cancelled");
	}
	entry.blobUrl = blobUrl;

	// Persist to IDB cache in background. A full cache or quota failure must
	// not turn an already displayed file into an unhandled rejection. Never
	// write one account's bytes into the database of another.
	if (getActiveAccountKey() === accountKey) {
		void fileCacheRepo.put(fileUrl, blob, blob.type).catch(() => {});
	}

	return blobUrl;
}
