import { getDB } from "./init.ts";
import { notify } from "./notify.ts";
import type { PendingBlob } from "./schema.ts";

export const pendingBlobsRepo = {
	async put(blob: PendingBlob): Promise<void> {
		const db = await getDB();
		await db.put("pendingBlobs", blob);
	},

	async get(id: string): Promise<PendingBlob | undefined> {
		const db = await getDB();
		return db.get("pendingBlobs", id);
	},

	async delete(id: string): Promise<void> {
		const db = await getDB();
		await db.delete("pendingBlobs", id);
		notify();
	},

	async deleteMany(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("pendingBlobs", "readwrite");
		await Promise.all(ids.map((id) => tx.store.delete(id)));
		await tx.done;
		notify();
	},
};
