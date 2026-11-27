import { getActiveAccountKey, getDB, getDBFor } from "./init.ts";
import type { DecryptedFile } from "./schema.ts";

// A separate limit from the ciphertext cache: the plaintext is what makes a
// second view instant, but it must not push the ciphertext of the same file
// out and force a re-download after every restart.
const MAX_DECRYPTED_FILES = 100;
const MAX_DECRYPTED_BYTES = 100 * 1024 * 1024;

async function byteLimit(): Promise<number> {
	try {
		const estimate = await navigator.storage?.estimate?.();
		if (estimate?.quota !== undefined && estimate.quota > 0) {
			return Math.min(
				MAX_DECRYPTED_BYTES,
				Math.max(20 * 1024 * 1024, Math.floor(estimate.quota * 0.05)),
			);
		}
	} catch {
		// Private mode or a browser without storage.estimate.
	}

	return MAX_DECRYPTED_BYTES;
}

export const decryptedFilesRepo = {
	async get(key: string): Promise<DecryptedFile | undefined> {
		const db = await getDB();
		// The read and the LRU touch share one transaction: a concurrent
		// clear (local lock, account switch) is serialized with them, so a
		// touch cannot restore plaintext after the lock removed it.
		const tx = db.transaction("decryptedFiles", "readwrite");
		const entry = await tx.store.get(key);
		if (entry !== undefined) {
			try {
				// The copy given to the caller stays as read. A failed touch
				// must not break an already successful read.
				await tx.store.put({
					...entry,
					lastAccessedAt: Date.now(),
				});
			} catch {
				// A failed touch must not break an already successful read.
			}
		}
		await tx.done.catch(() => {});

		return entry;
	},

	async put(
		key: string,
		bytes: ArrayBuffer,
		mimeType: string,
		accountKey: string | null,
	): Promise<void> {
		if (bytes.byteLength > MAX_DECRYPTED_BYTES) return;
		// The caller captured the account before the async decrypt. Check it
		// again after every await: a switch in between must not write one
		// account's plaintext into another account's database.
		if (getActiveAccountKey() !== accountKey) return;
		if (bytes.byteLength > (await byteLimit())) return;
		if (getActiveAccountKey() !== accountKey) return;
		const db = await getDB();
		const now = Date.now();
		const entry: DecryptedFile = {
			key,
			bytes,
			mimeType,
			cachedAt: now,
			lastAccessedAt: now,
			size: bytes.byteLength,
		};
		await db.put("decryptedFiles", entry);
		await this.evictIfNeeded(key);
	},

	async remove(key: string): Promise<void> {
		const db = await getDB();
		await db.delete("decryptedFiles", key);
	},

	// removeByFileUrl drops every decrypted copy of one attachment. Keys embed
	// the file key version, so all versions must go when the message that owned
	// the file is deleted; otherwise the plaintext outlives the message.
	async removeByFileUrl(fileUrl: string): Promise<void> {
		const db = await getDB();
		const prefix = `decrypted:${fileUrl}:`;
		const tx = db.transaction("decryptedFiles", "readwrite");
		let cursor = await tx.store.openCursor();
		while (cursor !== null) {
			if (String(cursor.key).startsWith(prefix)) {
				await cursor.delete();
			}
			cursor = await cursor.continue();
		}
		await tx.done;
	},

	async isCached(key: string): Promise<boolean> {
		const db = await getDB();
		return (await db.get("decryptedFiles", key)) !== undefined;
	},

	// clear removes every cached plaintext attachment. Called when a local
	// lock closes so decrypted media does not survive behind the PIN.
	async clear(
		accountKey: string | null = getActiveAccountKey(),
	): Promise<void> {
		const db = await getDBFor(accountKey);
		await db.clear("decryptedFiles");
	},

	async evictIfNeeded(keepKey?: string): Promise<void> {
		const db = await getDB();
		const all = await db.getAll("decryptedFiles");
		if (all.length === 0) return;

		const maxBytes = await byteLimit();
		let total = all.reduce((sum, entry) => sum + entry.size, 0);
		all.sort(
			(a, b) =>
				(a.lastAccessedAt ?? a.cachedAt) - (b.lastAccessedAt ?? b.cachedAt),
		);

		const toDelete: DecryptedFile[] = [];
		let count = all.length;
		for (const entry of all) {
			if (count <= MAX_DECRYPTED_FILES && total <= maxBytes) break;
			if (entry.key === keepKey) continue;
			toDelete.push(entry);
			count--;
			total -= entry.size;
		}
		if (toDelete.length === 0) return;

		const tx = db.transaction("decryptedFiles", "readwrite");
		await Promise.all(toDelete.map((f) => tx.store.delete(f.key)));
		await tx.done;
	},
};
