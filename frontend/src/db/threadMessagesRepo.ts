import type { Message, MessageStatus } from "../types/api.ts";
import { getDB } from "./init.ts";
import { notify } from "./notify.ts";
import type { StoredThreadMessage } from "./schema.ts";

export type StoredThreadStatus = MessageStatus | "deleted";

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
	async getByThread(threadId: string): Promise<StoredThreadMessage[]> {
		const db = await getDB();
		const all = await db.getAllFromIndex(
			"threadMessages",
			"threadId",
			threadId,
		);
		return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	},

	async getById(
		threadId: string,
		messageId: string,
	): Promise<StoredThreadMessage | undefined> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing === undefined) return undefined;
		if (existing.threadId !== threadId) return undefined;
		return existing;
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
		await db.put("threadMessages", {
			...stamp(message, resolvedStatus, threadId),
			createdAt,
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
		for (const m of messages) {
			const existing = await tx.store.get(m.id);
			const createdAt = existing?.createdAt ?? m.createdAt;
			await tx.store.put({ ...stamp(m, status, threadId), createdAt });
		}
		await tx.done;
		notify();
	},

	async applyDelete(threadId: string, messageId: string): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing === undefined || existing.threadId !== threadId) {
			notify();
			return;
		}
		await db.put("threadMessages", { ...existing, status: "deleted" });
		notify();
	},

	async remove(threadId: string, messageId: string): Promise<void> {
		const db = await getDB();
		const existing = await db.get("threadMessages", messageId);
		if (existing !== undefined && existing.threadId === threadId) {
			await db.delete("threadMessages", messageId);
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
};
