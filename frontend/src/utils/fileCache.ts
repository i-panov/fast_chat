import { fileCacheRepo } from "../db/fileCacheRepo.ts";

const inMemoryCache = new Map<
	string,
	{ blobUrl: string; refCount: number; promise: Promise<string> }
>();

function getToken(): string | undefined {
	try {
		return sessionStorage.getItem("activeToken") ?? undefined;
	} catch {
		return undefined;
	}
}

export async function acquireFileBlobUrl(
	fileUrl: string,
	token?: string,
): Promise<string> {
	if (fileUrl.startsWith("blob:")) return fileUrl;

	const existing = inMemoryCache.get(fileUrl);
	if (existing) {
		existing.refCount++;
		return existing.promise;
	}

	const promise = loadFile(fileUrl, token);
	inMemoryCache.set(fileUrl, { blobUrl: "", refCount: 1, promise });
	return promise;
}

export function releaseFileBlobUrl(fileUrl: string): void {
	if (fileUrl.startsWith("blob:")) return;

	const entry = inMemoryCache.get(fileUrl);
	if (!entry) return;
	entry.refCount--;
	if (entry.refCount <= 0) {
		if (entry.blobUrl) {
			URL.revokeObjectURL(entry.blobUrl);
		}
		inMemoryCache.delete(fileUrl);
	}
}

async function loadFile(fileUrl: string, token?: string): Promise<string> {
	// Try IDB cache first
	const cached = await fileCacheRepo.get(fileUrl);
	if (cached !== undefined) {
		const blobUrl = URL.createObjectURL(cached.blob);
		const entry = inMemoryCache.get(fileUrl);
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

	const entry = inMemoryCache.get(fileUrl);
	if (!entry) {
		URL.revokeObjectURL(blobUrl);
		throw new Error("File request cancelled");
	}
	entry.blobUrl = blobUrl;

	// Persist to IDB cache in background
	void fileCacheRepo.put(fileUrl, blob, blob.type);

	return blobUrl;
}
