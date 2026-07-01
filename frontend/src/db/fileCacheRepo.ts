import { getDB } from "./init.ts";
import type { CachedFile } from "./schema.ts";

const MAX_CACHED_FILES = 200;

export const fileCacheRepo = {
	async get(url: string): Promise<CachedFile | undefined> {
		const db = await getDB();
		return db.get("fileCache", url);
	},

	async put(url: string, blob: Blob, mimeType: string): Promise<void> {
		const db = await getDB();
		const entry: CachedFile = {
			url,
			blob,
			mimeType,
			cachedAt: Date.now(),
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
		const count = await db.count("fileCache");
		if (count <= MAX_CACHED_FILES) return;

		const all = await db.getAllFromIndex("fileCache", "cachedAt");
		all.sort((a, b) => a.cachedAt - b.cachedAt);

		const toDelete = all.slice(0, all.length - MAX_CACHED_FILES);
		if (toDelete.length === 0) return;

		const tx = db.transaction("fileCache", "readwrite");
		await Promise.all(toDelete.map((f) => tx.store.delete(f.url)));
		await tx.done;
	},
};
