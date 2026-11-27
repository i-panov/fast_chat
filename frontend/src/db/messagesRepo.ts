import type {
	Message,
	MessageDeliveryStatus,
	MessageStatus,
} from "../types/api.ts";
import { compareByCreatedAt } from "../utils/ordering.ts";
import { decryptedFilesRepo } from "./decryptedFilesRepo.ts";
import { getDB } from "./init.ts";
import {
	dropReplacedLocalFileUrls,
	releaseLocalFileUrls,
} from "./localFileUrls.ts";
import { notify } from "./notify.ts";
import type { StoredMessage } from "./schema.ts";

export type StoredStatus = MessageStatus | "deleted";

function stamp(message: Message, status: StoredStatus): StoredMessage {
	return { ...message, status, _updatedAt: new Date().toISOString() };
}

// A deleted message must not leave its decrypted attachments on disk: the
// bytes are the plaintext of an E2EE file, and "delete" is expected to remove
// them. The cache key embeds the file key, so removal is by URL prefix.
async function dropDecryptedFiles(
	files: StoredMessage["files"],
): Promise<void> {
	for (const file of files ?? []) {
		await decryptedFilesRepo.removeByFileUrl(file.url).catch(() => {});
	}
}

export const messagesRepo = {
	async getByChat(chatId: string): Promise<StoredMessage[]> {
		const db = await getDB();
		const all = await db.getAllFromIndex("messages", "chatId", chatId);

		return all.sort((a, b) =>
			compareByCreatedAt(a.createdAt, b.createdAt, a.id, b.id),
		);
	},

	async getAll(): Promise<StoredMessage[]> {
		const db = await getDB();
		return db.getAll("messages");
	},

	async getById(
		chatId: string,
		messageId: string,
	): Promise<StoredMessage | undefined> {
		const db = await getDB();
		const existing = await db.get("messages", messageId);
		if (existing === undefined) return;
		if (existing.chatId !== chatId) return;
		return existing;
	},

	async getByIdAny(messageId: string): Promise<StoredMessage | undefined> {
		const db = await getDB();
		return db.get("messages", messageId);
	},

	async upsert(message: Message, status?: StoredStatus): Promise<void> {
		const db = await getDB();
		const existing = await db.get("messages", message.id);
		const createdAt = existing?.createdAt ?? message.createdAt;
		const resolvedStatus =
			status ??
			(existing !== undefined &&
			(existing.status === "queued" || existing.status === "failed")
				? existing.status
				: "sent");

		// Preserve existing delivery status if it's already "read" (immutable state)
		const deliveryStatus =
			existing?.deliveryStatus === "read"
				? "read"
				: (message.deliveryStatus ?? existing?.deliveryStatus);

		// Preserve existing readBy list if we already have one
		const readBy =
			existing?.readBy && existing.readBy.length > 0
				? existing.readBy
				: message.readBy;

		await db.put("messages", {
			...stamp(message, resolvedStatus),
			createdAt,
			deliveryStatus,
			readBy,
		});
		// The server copy replaces the optimistic row: revoke its local preview
		// URLs only after the write committed, so a failed put cannot leave the
		// stored row pointing at a revoked URL.
		dropReplacedLocalFileUrls(existing?.files, message.files);
		notify();
	},

	async updateReactions(
		chatId: string,
		messageId: string,
		reactions: Message["reactions"],
	): Promise<void> {
		const db = await getDB();
		const existing = await db.get("messages", messageId);
		if (existing === undefined || existing.chatId !== chatId) return;
		await db.put("messages", {
			...existing,
			reactions,
			_updatedAt: new Date().toISOString(),
		});
		notify();
	},

	async upsertMany(
		messages: Message[],
		status: StoredStatus = "sent",
	): Promise<void> {
		if (messages.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("messages", "readwrite");
		const replaced: Array<{
			previous: Message["files"];
			next: Message["files"];
		}> = [];
		for (const m of messages) {
			const existing = await tx.store.get(m.id);
			const createdAt = existing?.createdAt ?? m.createdAt;

			// Preserve existing delivery status if it's already "read" (immutable state)
			const deliveryStatus =
				existing?.deliveryStatus === "read"
					? "read"
					: (m.deliveryStatus ?? existing?.deliveryStatus);

			// Preserve existing readBy list if we already have one
			const readBy =
				existing?.readBy && existing.readBy.length > 0
					? existing.readBy
					: m.readBy;

			const stored: StoredMessage = {
				...stamp(m, status),
				createdAt,
				deliveryStatus,
				readBy,
			};
			replaced.push({ previous: existing?.files, next: m.files });
			await tx.store.put(stored);
		}
		await tx.done;
		for (const row of replaced) {
			dropReplacedLocalFileUrls(row.previous, row.next);
		}
		notify();
	},

	async applyDelete(chatId: string, messageId: string): Promise<void> {
		const db = await getDB();
		const existing = await db.get("messages", messageId);
		if (existing === undefined) {
			notify();
			return;
		}
		if (existing.chatId !== chatId) {
			notify();
			return;
		}
		// Preserve the row but mark it as locally deleted so the
		// server-side edit/delete delta can still override it. The
		// UI filters on status === "deleted" to hide these. The local
		// previews are hidden with it, so release them after the write: a
		// failed put must not leave the row pointing at a revoked URL.
		await db.put("messages", {
			...existing,
			status: "deleted",
			files: undefined,
		});
		releaseLocalFileUrls(existing.files);
		await dropDecryptedFiles(existing.files);
		notify();
	},

	async remove(chatId: string, messageId: string): Promise<void> {
		const db = await getDB();
		const existing = await db.get("messages", messageId);
		if (existing !== undefined && existing.chatId === chatId) {
			await db.delete("messages", messageId);
			releaseLocalFileUrls(existing.files);
			await dropDecryptedFiles(existing.files);
			notify();
		}
	},

	async markStatus(
		chatId: string,
		messageId: string,
		status: StoredStatus,
	): Promise<void> {
		const db = await getDB();
		const existing = await db.get("messages", messageId);
		if (existing === undefined || existing.chatId !== chatId) return;
		await db.put("messages", { ...existing, status });
		notify();
	},

	async removeByChat(chatId: string): Promise<void> {
		const db = await getDB();
		const tx = db.transaction("messages", "readwrite");
		const files: StoredMessage["files"][] = [];
		let cursor = await tx.store.index("chatId").openCursor(chatId);
		while (cursor !== null) {
			files.push(cursor.value.files);
			releaseLocalFileUrls(cursor.value.files);
			await cursor.delete();
			cursor = await cursor.continue();
		}
		await tx.done;
		for (const messageFiles of files) {
			await dropDecryptedFiles(messageFiles);
		}
		notify();
	},

	async getPending(): Promise<StoredMessage[]> {
		const db = await getDB();
		const queued = await db.getAllFromIndex("messages", "status", "queued");
		return queued;
	},

	async updateDeliveryStatus(
		messageId: string,
		deliveryStatus: MessageDeliveryStatus,
		readBy?: string[],
	): Promise<void> {
		const db = await getDB();
		const existing = await db.get("messages", messageId);
		if (existing === undefined) return;
		const updated: StoredMessage = {
			...existing,
			deliveryStatus,
			_updatedAt: new Date().toISOString(),
		};
		if (readBy !== undefined) {
			updated.readBy = readBy;
		}
		await db.put("messages", updated);
		notify();
	},

	async markAsRead(messageIds: string[]): Promise<void> {
		if (messageIds.length === 0) return;
		const db = await getDB();
		const tx = db.transaction("messages", "readwrite");
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

	async getReadMessageIds(): Promise<string[]> {
		const db = await getDB();
		const all = await db.getAll("messages");
		return all.filter((m) => m.deliveryStatus === "read").map((m) => m.id);
	},
};
