import type { Chat } from "../types/api.ts";
import { getDB } from "./init.ts";
import { notify } from "./notify.ts";
import type { StoredChat } from "./schema.ts";

function stamp(chat: Chat): StoredChat {
	return { ...chat, _updatedAt: new Date().toISOString() };
}

export const chatsRepo = {
	async getAll(): Promise<StoredChat[]> {
		const db = await getDB();
		const all = await db.getAll("chats");

		return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	},

	async getById(id: string): Promise<StoredChat | undefined> {
		const db = await getDB();
		return db.get("chats", id);
	},

	async upsert(chat: Chat): Promise<void> {
		const db = await getDB();
		await db.put("chats", stamp(chat));
		notify();
	},

	async upsertMany(chats: Chat[]): Promise<void> {
		if (chats.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("chats", "readwrite");
		const stamped = chats.map(stamp);
		await Promise.all(stamped.map((c) => tx.store.put(c)));
		await tx.done;
		notify();
	},

	async remove(id: string): Promise<void> {
		const db = await getDB();
		await db.delete("chats", id);
		notify();
	},

	async removeMany(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("chats", "readwrite");
		await Promise.all(ids.map((id) => tx.store.delete(id)));
		await tx.done;
		notify();
	},

	async updateMemberStatus(userId: string, online: boolean): Promise<void> {
		const db = await getDB();
		const chats = await db.getAll("chats");
		const tx = db.transaction("chats", "readwrite");
		for (const chat of chats) {
			const memberIndex = chat.members.findIndex((m) => m.id === userId);
			if (memberIndex !== -1) {
				chat.members[memberIndex] = {
					...chat.members[memberIndex],
					online,
				};
				chat._updatedAt = new Date().toISOString();
				await tx.store.put(chat);
			}
		}
		await tx.done;
		notify();
	},
};
