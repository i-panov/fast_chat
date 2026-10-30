import { getSync } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import type { Message, SyncResponse } from "../types/api.ts";

const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";

// applyDelta folds a /api/sync response into the local IDB cache.
// It implements LWW conflict resolution: when the server reports a
// message edited at a later timestamp than the user's local queued
// edit, the local outbox op is dropped; otherwise the local edit
// will be replayed over the server copy on the next outbox tick.
export async function applyDelta(delta: SyncResponse): Promise<void> {
	const outbox = await outboxRepo.list();

	const chats = delta.chats ?? [];
	const deletedChats = delta.deletedChats ?? [];
	const messages = delta.messages ?? [];
	const threadMessages = delta.threadMessages ?? [];
	const deletedMessages = delta.deletedMessages ?? [];

	// The removals are applied before the chat list: a member who left a
	// group and came back is in the list again, and the chat must survive the
	// tombstone of the earlier removal.
	if (deletedChats.length > 0) {
		await chatsRepo.removeMany(deletedChats.map((d) => d.chatId));
	}

	if (chats.length > 0) {
		await chatsRepo.upsertMany(chats);
	}

	if (delta.onlineStatus) {
		for (const [userId, online] of Object.entries(delta.onlineStatus)) {
			await chatsRepo.updateMemberStatus(userId, online);
		}
	}

	await applyMessages(messages, outbox);

	// The messages of the threads go into their own store: the chat feed
	// holds the top-level messages only. Thread records get the same
	// queued/failed guard and LWW resolution as top-level messages so a
	// parallel send in a thread is not clobbered by the delta.
	await applyThreadMessages(threadMessages, outbox);

	await applyDeletions(deletedMessages, outbox);

	await metaRepo.setLastSyncedAt(delta.serverNow);
}

// applyMessages stores the chat messages of the delta, resolving the
// conflicts with the local outbox.
async function applyMessages(
	messages: Message[],
	outbox: OutboxOp[],
): Promise<void> {
	if (messages.length === 0) return;

	const stored: Message[] = [];

	for (const msg of messages) {
		const local = await messagesRepo.getById(msg.chatId, msg.id);

		// If we have a queued send-op for this id, keep the local
		// copy (which contains our pending file references) and
		// let the outbox finish uploading/inserting. The server
		// will then resend the canonical record with status sent.
		if (local?.status === "queued" || local?.status === "failed") {
			continue;
		}

		// LWW: if a queued edit was beaten by a fresher server
		// edit, drop the local outbox op and accept the server
		// record. Otherwise the local row stays for replay: a server copy
		// without a (newer) editedAt predates our edit, and overwriting it
		// would lose the edit if the replay later fails.
		const editOp = outbox.find(
			(o) => o.kind === "edit" && o.messageId === msg.id,
		);
		if (editOp !== undefined && editOp.kind === "edit") {
			const serverEditedAt =
				msg.editedAt !== undefined ? new Date(msg.editedAt).getTime() : NaN;
			const localEditedAt = new Date(editOp.clientEditedAt).getTime();
			if (
				!Number.isNaN(serverEditedAt) &&
				!Number.isNaN(localEditedAt) &&
				serverEditedAt > localEditedAt
			) {
				await outboxRepo.remove(editOp.opId);
				if (editOp.pendingFileClientIds.length > 0) {
					await pendingBlobsRepo.deleteMany(editOp.pendingFileClientIds);
				}
			} else {
				// The local edit is newer (or the timestamps are not
				// comparable): keep the outbox op for replay and do not
				// overwrite the local row with the stale server copy —
				// otherwise a failed replay would lose the edit.
				continue;
			}
		}

		stored.push(msg);
	}

	if (stored.length > 0) {
		await messagesRepo.upsertMany(stored);
	}
}

// applyThreadMessages stores the thread messages of the delta with the
// same conflict resolution as top-level messages: queued/failed locals
// are kept for the outbox, and LWW decides between a queued edit and a
// fresher server edit.
async function applyThreadMessages(
	threadMessages: Message[],
	outbox: OutboxOp[],
): Promise<void> {
	if (threadMessages.length === 0) return;

	const stored: { threadId: string; msg: Message }[] = [];

	for (const msg of threadMessages) {
		if (msg.threadId === undefined) continue;

		const local = await threadMessagesRepo.getById(msg.threadId, msg.id);

		if (local?.status === "queued" || local?.status === "failed") {
			continue;
		}

		const editOp = outbox.find(
			(o) => o.kind === "edit" && o.messageId === msg.id,
		);
		if (editOp !== undefined && editOp.kind === "edit") {
			const serverEditedAt =
				msg.editedAt !== undefined ? new Date(msg.editedAt).getTime() : NaN;
			const localEditedAt = new Date(editOp.clientEditedAt).getTime();
			if (
				!Number.isNaN(serverEditedAt) &&
				!Number.isNaN(localEditedAt) &&
				serverEditedAt > localEditedAt
			) {
				await outboxRepo.remove(editOp.opId);
				if (editOp.pendingFileClientIds.length > 0) {
					await pendingBlobsRepo.deleteMany(editOp.pendingFileClientIds);
				}
			} else {
				// Same as top-level messages: without a (newer) server
				// editedAt the local edit stays for replay.
				continue;
			}
		}

		stored.push({ threadId: msg.threadId, msg });
	}

	if (stored.length > 0) {
		// Group by thread to keep the per-thread upsertMany contract.
		const byThread = new Map<string, Message[]>();
		for (const { threadId, msg } of stored) {
			const list = byThread.get(threadId) ?? [];
			list.push(msg);
			byThread.set(threadId, list);
		}
		for (const [threadId, list] of byThread) {
			await threadMessagesRepo.upsertMany(list, threadId);
		}
	}
}

// applyDeletions marks the deleted messages of the delta and cleans up the
// outbox operations that became redundant.
async function applyDeletions(
	deletedMessages: SyncResponse["deletedMessages"],
	outbox: OutboxOp[],
): Promise<void> {
	for (const d of deletedMessages) {
		// If we have a queued send-op for this id, the user's send is
		// still pending. The server will replay the delete once the
		// send arrives. We do not modify the local row.
		const sendOp = outbox.find(
			(o) => o.kind === "send" && o.msgId === d.messageId,
		);
		if (sendOp !== undefined) continue;

		// If we have a queued delete-op, it's now redundant — the
		// server already removed the message, so the op is a no-op.
		const deleteOp = outbox.find(
			(o) => o.kind === "delete" && o.messageId === d.messageId,
		);
		if (deleteOp !== undefined) {
			await outboxRepo.remove(deleteOp.opId);
		}

		await messagesRepo.applyDelete(d.chatId, d.messageId);

		// The same tombstone covers the messages of the threads: they live in
		// their own store, and a deleted thread message has to disappear from
		// it as well.
		const threadMessage = await threadMessagesRepo.getByIdAny(d.messageId);
		if (threadMessage !== undefined) {
			await threadMessagesRepo.applyDelete(threadMessage.threadId, d.messageId);
		}
	}
}

export function pullDelta(
	token: string,
	since: string | null,
	signal?: AbortSignal,
	limit?: number,
	sinceId?: string,
): Promise<SyncResponse> {
	return getSync(token, since ?? DEFAULT_SINCE, signal, limit, sinceId);
}

// maxSyncRounds bounds one sync tick: a chat receiving live writes could
// otherwise keep every page full forever. The cursor below always points
// at undelivered data, so the remainder arrives on the next tick.
export const maxSyncRounds = 50;
