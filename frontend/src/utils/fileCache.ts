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

async function loadFile(
	key: string,
	fileUrl: string,
	token?: string,
): Promise<string> {
	// Try IDB cache first (the IDB itself is per-account).
	const cached = await fileCacheRepo.get(fileUrl);
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

	// Persist to IDB cache in background
	void fileCacheRepo.put(fileUrl, blob, blob.type);

	return blobUrl;
}
