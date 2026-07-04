import type { Thread } from "../types/api.ts";
import { getDB } from "./init.ts";
import { notify } from "./notify.ts";
import type { StoredThread } from "./schema.ts";

function stamp(t: Thread): StoredThread {
	return { ...t, _updatedAt: new Date().toISOString() };
}

export const threadsRepo = {
	async getAll(): Promise<StoredThread[]> {
		const db = await getDB();
		return db.getAll("threads");
	},

	async getByChat(chatId: string): Promise<StoredThread[]> {
		const db = await getDB();
		return db.getAllFromIndex("threads", "chatId", chatId);
	},

	async getById(id: string): Promise<StoredThread | undefined> {
		const db = await getDB();
		return db.get("threads", id);
	},

	async upsert(thread: Thread): Promise<void> {
		const db = await getDB();
		await db.put("threads", stamp(thread));
		notify();
	},

	async upsertMany(threads: Thread[]): Promise<void> {
		if (threads.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("threads", "readwrite");
		await Promise.all(threads.map((t) => tx.store.put(stamp(t))));
		await tx.done;
		notify();
	},

	async remove(id: string): Promise<void> {
		const db = await getDB();
		await db.delete("threads", id);
		notify();
	},

	async removeByChat(chatId: string): Promise<void> {
		const all = await this.getByChat(chatId);
		if (all.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("threads", "readwrite");
		await Promise.all(all.map((t) => tx.store.delete(t.id)));
		await tx.done;
		notify();
	},
};
