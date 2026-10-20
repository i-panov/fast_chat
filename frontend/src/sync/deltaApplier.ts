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
	// holds the top-level messages only.
	for (const msg of threadMessages) {
		if (msg.threadId === undefined) continue;

		await threadMessagesRepo.upsert(msg, msg.threadId, "sent");
	}

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
		// record.
		const editOp = outbox.find(
			(o) => o.kind === "edit" && o.messageId === msg.id,
		);
		const serverEditedAt =
			msg.editedAt !== undefined ? new Date(msg.editedAt).getTime() : NaN;
		const localEditedAt =
			editOp !== undefined && editOp.kind === "edit"
				? new Date(editOp.clientEditedAt).getTime()
				: NaN;
		// NaN comparisons are always false, so a malformed/empty
		// timestamp never wins the conflict — the server record is
		// accepted as-is.
		if (
			editOp !== undefined &&
			editOp.kind === "edit" &&
			!Number.isNaN(serverEditedAt) &&
			!Number.isNaN(localEditedAt) &&
			serverEditedAt > localEditedAt
		) {
			await outboxRepo.remove(editOp.opId);
			if (editOp.pendingFileClientIds.length > 0) {
				await pendingBlobsRepo.deleteMany(editOp.pendingFileClientIds);
			}
		}

		stored.push(msg);
	}

	if (stored.length > 0) {
		await messagesRepo.upsertMany(stored);
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
): Promise<SyncResponse> {
	return getSync(token, since ?? DEFAULT_SINCE);
}
