import type {
	Message,
	MessageDeliveryStatus,
	MessageStatus,
} from "../types/api.ts";
import { compareByCreatedAt } from "../utils/ordering.ts";
import { getDB } from "./init.ts";
import {
	dropReplacedLocalFileUrls,
	releaseLocalFileUrls,
} from "./localFileUrls.ts";
import { notify } from "./notify.ts";
import type { StoredThreadMessage } from "./schema.ts";

export type StoredThreadStatus = MessageStatus | "deleted";

// unionReadBy merges the readers of the stored row and the incoming
// record: either side may carry readers the other one missed (delta
// replay vs SSE event arriving in any order), and picking one side
// would silently drop read receipts.
function unionReadBy(
	existing: string[] | undefined,
	incoming: string[] | undefined,
): string[] | undefined {
	if (
		(existing === undefined || existing.length === 0) &&
		(incoming === undefined || incoming.length === 0)
	) {
		return incoming;
	}
	return [...new Set([...(existing ?? []), ...(incoming ?? [])])];
}

function stamp(
	msg: Message,
	status: StoredThreadStatus,
	threadId: string,
): StoredThreadMessage {
	return {
		...msg,
		threadId,
		status,
		_updatedAt: new Date().toISOString(),
	};
}

export const threadMessagesRepo = {
	async removeByChat(chatId: string): Promise<void> {
		const db = await getDB();
		const tx = db.transaction("threadMessages", "readwrite");
		let cursor = await tx.store.index("chatId").openCursor(chatId);
		while (cursor !== null) {
			releaseLocalFileUrls(cursor.value.files);
			await cursor.delete();
			cursor = await cursor.continue();
		}
		await tx.done;
		notify();
	},

	async getByThread(threadId: string): Promise<StoredThreadMessage[]> {
		const db = await getDB();
		const all = await db.getAllFromIndex(
			"threadMessages",
			"threadId",
			threadId,
		);
		return all.sort((a, b) =>
			compareByCreatedAt(a.createdAt, b.createdAt, a.id, b.id),
		);
	},

	async getById(
		threadId: string,
		messageId: string,
	): Promise<StoredThreadMessage | undefined> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing === undefined) return;
		if (existing.threadId !== threadId) return;
		return existing;
	},

	async getByIdAny(
		messageId: string,
	): Promise<StoredThreadMessage | undefined> {
		const db = await getDB();
		return db.get("threadMessages", messageId);
	},

	async upsert(
		message: Message,
		threadId: string,
		status?: StoredThreadStatus,
	): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", message.id);
		const createdAt = existing?.createdAt ?? message.createdAt;
		const resolvedStatus =
			status ??
			(existing !== undefined &&
			(existing.status === "queued" || existing.status === "failed")
				? existing.status
				: "sent");
		// Preserve delivery/read receipts like messagesRepo: a delta or SSE
		// replay must not reset an already-"read" message or drop readers.
		const deliveryStatus =
			existing?.deliveryStatus === "read"
				? "read"
				: (message.deliveryStatus ?? existing?.deliveryStatus);
		const readBy = unionReadBy(existing?.readBy, message.readBy);

		await db.put("threadMessages", {
			...stamp(message, resolvedStatus, threadId),
			createdAt,
			deliveryStatus,
			readBy,
		});
		// Revoke after the commit, like messagesRepo: a failed write must not
		// leave the stored row pointing at a dead preview URL.
		dropReplacedLocalFileUrls(existing?.files, message.files);
		notify();
	},

	async updateReactions(
		threadId: string,
		messageId: string,
		reactions: Message["reactions"],
	): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing === undefined || existing.threadId !== threadId) return;
		await db.put("threadMessages", {
			...existing,
			reactions,
			_updatedAt: new Date().toISOString(),
		});
		notify();
	},

	async upsertMany(
		messages: Message[],
		threadId: string,
		status: StoredThreadStatus = "sent",
	): Promise<void> {
		if (messages.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("threadMessages", "readwrite");
		const replaced: Array<{
			previous: Message["files"];
			next: Message["files"];
		}> = [];
		for (const m of messages) {
			const existing = await tx.store.get(m.id);
			const createdAt = existing?.createdAt ?? m.createdAt;
			const deliveryStatus =
				existing?.deliveryStatus === "read"
					? "read"
					: (m.deliveryStatus ?? existing?.deliveryStatus);
			const readBy = unionReadBy(existing?.readBy, m.readBy);
			replaced.push({ previous: existing?.files, next: m.files });
			await tx.store.put({
				...stamp(m, status, threadId),
				createdAt,
				deliveryStatus,
				readBy,
			});
		}
		await tx.done;
		for (const row of replaced) {
			dropReplacedLocalFileUrls(row.previous, row.next);
		}
		notify();
	},

	async applyDelete(threadId: string, messageId: string): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing === undefined || existing.threadId !== threadId) {
			notify();
			return;
		}
		// The tombstone is hidden by the UI, so its local previews are dead
		// references from this point on. Release them after the write, so a
		// failed put cannot leave the stored row pointing at a revoked URL.
		await db.put("threadMessages", {
			...existing,
			status: "deleted",
			files: undefined,
		});
		releaseLocalFileUrls(existing.files);
		notify();
	},

	async remove(threadId: string, messageId: string): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing !== undefined && existing.threadId === threadId) {
			await db.delete("threadMessages", messageId);
			releaseLocalFileUrls(existing.files);
			notify();
		}
	},

	async markStatus(
		threadId: string,
		messageId: string,
		status: StoredThreadStatus,
	): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing === undefined || existing.threadId !== threadId) return;
		await db.put("threadMessages", { ...existing, status });
		notify();
	},

	async updateDeliveryStatus(
		messageId: string,
		deliveryStatus: MessageDeliveryStatus,
		readBy?: string[],
	): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing === undefined) return;
		const updated: StoredThreadMessage = {
			...existing,
			deliveryStatus,
			_updatedAt: new Date().toISOString(),
		};
		if (readBy !== undefined) {
			updated.readBy = readBy;
		}
		await db.put("threadMessages", updated);
		notify();
	},

	async markAsRead(messageIds: string[]): Promise<void> {
		if (messageIds.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("threadMessages", "readwrite");
		for (const id of messageIds) {
			const existing = await tx.store.get(id);
			if (existing !== undefined) {
				await tx.store.put({
					...existing,
					deliveryStatus: "read",
					_updatedAt: new Date().toISOString(),
				});
			}
		}
		await tx.done;
		notify();
	},
};
