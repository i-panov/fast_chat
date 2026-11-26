import { getDB } from "./init.ts";
import type { CachedFile } from "./schema.ts";

const MAX_CACHED_FILES = 200;
// Bounds for the local media cache. Large files are not cached implicitly:
// video/audio would otherwise fill the origin quota after a few views.
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const MAX_AUTO_CACHE_BYTES = 50 * 1024 * 1024;

// Keep the cache inside the browser quota as well as the fixed cap. The
// estimate API is advisory; when it is unavailable the fixed cap applies.
async function cacheByteLimit(): Promise<number> {
	try {
		const estimate = await navigator.storage?.estimate?.();
		if (estimate?.quota !== undefined && estimate.quota > 0) {
			return Math.min(
				MAX_CACHE_BYTES,
				Math.max(MAX_AUTO_CACHE_BYTES, Math.floor(estimate.quota * 0.1)),
			);
		}
	} catch {
		// Private mode or a browser without storage.estimate.
	}
	return MAX_CACHE_BYTES;
}

export const fileCacheRepo = {
	async get(url: string): Promise<CachedFile | undefined> {
		const db = await getDB();
		const entry = await db.get("fileCache", url);
		if (entry === undefined) return;
		// Touch the entry so eviction can use true LRU rather than
		// insertion order. A failed touch must not break a successful read.
		await db
			.put("fileCache", { ...entry, lastAccessedAt: Date.now() })
			.catch(() => {});
		return entry;
	},

	// put reports whether the file was actually stored. An explicit offline
	// save must not claim success when the file does not fit the cache.
	async put(
		url: string,
		blob: Blob,
		mimeType: string,
		force = false,
	): Promise<boolean> {
		if (!force && blob.size > MAX_AUTO_CACHE_BYTES) return false;
		const maxBytes = await cacheByteLimit();
		if (blob.size > maxBytes) return false;
		const db = await getDB();
		const now = Date.now();
		const entry: CachedFile = {
			url,
			blob,
			mimeType,
			cachedAt: now,
			lastAccessedAt: now,
			size: blob.size,
		};
		await db.put("fileCache", entry);
		await this.evictIfNeeded(url);
		return true;
	},

	async remove(url: string): Promise<void> {
		const db = await getDB();
		await db.delete("fileCache", url);
	},

	async evictIfNeeded(keepUrl?: string): Promise<void> {
		const db = await getDB();
		const all = await db.getAll("fileCache");
		if (all.length === 0) return;

		const maxBytes = await cacheByteLimit();
		let total = all.reduce((sum, entry) => sum + entry.size, 0);
		// LRU: last AccessedAt first; older entries without it fall back to
		// their insertion time.
		all.sort(
			(a, b) =>
				(a.lastAccessedAt ?? a.cachedAt) - (b.lastAccessedAt ?? b.cachedAt),
		);

		const toDelete: CachedFile[] = [];
		let count = all.length;
		for (const entry of all) {
			if (count <= MAX_CACHED_FILES && total <= maxBytes) break;
			// Never evict the entry that was just written for an explicit
			// save: the caller would report success for a file that vanished.
			if (entry.url === keepUrl) continue;
			toDelete.push(entry);
			count--;
			total -= entry.size;
		}
		if (toDelete.length === 0) return;

		const tx = db.transaction("fileCache", "readwrite");
		await Promise.all(toDelete.map((f) => tx.store.delete(f.url)));
		await tx.done;
	},

	async isCached(url: string): Promise<boolean> {
		const db = await getDB();
		return (await db.get("fileCache", url)) !== undefined;
	},
};
