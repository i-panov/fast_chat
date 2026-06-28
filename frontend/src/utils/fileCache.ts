const cache = new Map<
	string,
	{ blobUrl: string; refCount: number; promise: Promise<string> }
>();

function getToken(): string | undefined {
	try {
		const raw = sessionStorage.getItem("activeToken");
		return raw ?? localStorage.getItem("activeToken") ?? undefined;
	} catch {
		return undefined;
	}
}

export async function acquireFileBlobUrl(
	fileUrl: string,
	token?: string,
): Promise<string> {
	if (fileUrl.startsWith("blob:")) return fileUrl;

	const existing = cache.get(fileUrl);
	if (existing) {
		existing.refCount++;
		return existing.promise;
	}

	const promise = loadFile(fileUrl, token);
	cache.set(fileUrl, { blobUrl: "", refCount: 1, promise });
	return promise;
}

export function releaseFileBlobUrl(fileUrl: string): void {
	if (fileUrl.startsWith("blob:")) return;

	const entry = cache.get(fileUrl);
	if (!entry) return;
	entry.refCount--;
	if (entry.refCount <= 0) {
		if (entry.blobUrl) {
			URL.revokeObjectURL(entry.blobUrl);
		}
		cache.delete(fileUrl);
	}
}

async function loadFile(fileUrl: string, token?: string): Promise<string> {
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

	const entry = cache.get(fileUrl);
	if (!entry) {
		URL.revokeObjectURL(blobUrl);
		throw new Error("File request cancelled");
	}
	entry.blobUrl = blobUrl;
	return blobUrl;
}
