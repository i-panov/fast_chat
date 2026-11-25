import type { Chat } from "../types/api.ts";
import { compareByCreatedAt } from "../utils/ordering.ts";
import { getDB } from "./init.ts";
import { messagesRepo } from "./messagesRepo.ts";
import { notify } from "./notify.ts";
import { outboxRepo } from "./outboxRepo.ts";
import type { StoredChat } from "./schema.ts";
import { threadMessagesRepo } from "./threadMessagesRepo.ts";
import { threadsRepo } from "./threadsRepo.ts";

function stamp(chat: Chat): StoredChat {
	return { ...chat, _updatedAt: new Date().toISOString() };
}

export const chatsRepo = {
	async getAll(): Promise<StoredChat[]> {
		const db = await getDB();
		const all = await db.getAll("chats");

		return all.sort((a, b) => {
			if (a.type === "self" && b.type !== "self") return -1;
			if (b.type === "self" && a.type !== "self") return 1;
			return compareByCreatedAt(a.createdAt, b.createdAt, a.id, b.id);
		});
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
		await this.removeMany([id]);
	},

	async removeMany(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("chats", "readwrite");
		await Promise.all(ids.map((id) => tx.store.delete(id)));
		await tx.done;
		// Messages and threads of a removed chat are unreachable from the UI;
		// keeping them would leak local preview URLs and stale history when a
		// private chat is reopened later.
		for (const id of ids) {
			await messagesRepo.removeByChat(id);
			await threadMessagesRepo.removeByChat(id);
			await threadsRepo.removeByChat(id);
			await outboxRepo.removeByChat(id);
		}
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
