import type { Chat } from "../types/api.ts";
import { compareByCreatedAt } from "../utils/ordering.ts";
import { getDB } from "./init.ts";
import { releaseLocalFileUrls } from "./localFileUrls.ts";
import { notify } from "./notify.ts";
import type { OutboxOp, StoredChat } from "./schema.ts";

function stamp(chat: Chat): StoredChat {
	return { ...chat, _updatedAt: new Date().toISOString() };
}

function pendingFileIds(op: OutboxOp): string[] {
	return "pendingFileClientIds" in op ? op.pendingFileClientIds : [];
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
		// One transaction keeps the invariant "no chat row means no rows of
		// that chat": a crash between five separate transactions could leave
		// messages, threads and queued sends behind a deleted chat.
		const tx = db.transaction(
			[
				"chats",
				"messages",
				"threads",
				"threadMessages",
				"outbox",
				"pendingBlobs",
			],
			"readwrite",
		);
		const chatIDs = new Set(ids);

		for (const id of ids) {
			await tx.objectStore("chats").delete(id);

			// Messages and thread messages of a removed chat are unreachable
			// from the UI; keeping them would leak local preview URLs and
			// stale history when a private chat is reopened later.
			const msgCursor = await tx
				.objectStore("messages")
				.index("chatId")
				.openCursor(id);
			for (
				let cursor = msgCursor;
				cursor !== null;
				cursor = await cursor.continue()
			) {
				releaseLocalFileUrls(cursor.value.files);
				await cursor.delete();
			}

			const threadMsgCursor = await tx
				.objectStore("threadMessages")
				.index("chatId")
				.openCursor(id);
			for (
				let cursor = threadMsgCursor;
				cursor !== null;
				cursor = await cursor.continue()
			) {
				releaseLocalFileUrls(cursor.value.files);
				await cursor.delete();
			}

			const threadCursor = await tx
				.objectStore("threads")
				.index("chatId")
				.openCursor(id);
			for (
				let cursor = threadCursor;
				cursor !== null;
				cursor = await cursor.continue()
			) {
				await cursor.delete();
			}
		}

		const outbox = await tx.objectStore("outbox").getAll();
		for (const op of outbox) {
			if (!chatIDs.has(op.chatId)) continue;
			await tx.objectStore("outbox").delete(op.opId);
			const pending = pendingFileIds(op);
			for (const id of pending) {
				await tx.objectStore("pendingBlobs").delete(id);
			}
		}

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
