import { getDB } from "./init.ts";
import type { CachedFile } from "./schema.ts";

const MAX_CACHED_FILES = 200;
// Bounds for the local media cache. Large files are not cached implicitly:
// video/audio would otherwise fill the origin quota after a few views.
export const MAX_CACHE_BYTES = 200 * 1024 * 1024;
export const MAX_AUTO_CACHE_BYTES = 50 * 1024 * 1024;

export const fileCacheRepo = {
	async get(url: string): Promise<CachedFile | undefined> {
		const db = await getDB();
		const entry = await db.get("fileCache", url);
		if (entry === undefined) return;
		// Touch the entry so eviction can use true LRU rather than
		// insertion order.
		await db.put("fileCache", { ...entry, lastAccessedAt: Date.now() });
		return entry;
	},

	async put(
		url: string,
		blob: Blob,
		mimeType: string,
		force = false,
	): Promise<void> {
		if (!force && blob.size > MAX_AUTO_CACHE_BYTES) return;
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
		await this.evictIfNeeded();
	},

	async remove(url: string): Promise<void> {
		const db = await getDB();
		await db.delete("fileCache", url);
	},

	async evictIfNeeded(): Promise<void> {
		const db = await getDB();
		const all = await db.getAll("fileCache");
		if (all.length === 0) return;

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
			if (count <= MAX_CACHED_FILES && total <= MAX_CACHE_BYTES) break;
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
