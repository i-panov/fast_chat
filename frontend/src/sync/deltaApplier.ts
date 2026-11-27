import { getSync } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { getActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp, OutboxOpPin } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import type { Message, SyncResponse } from "../types/api.ts";

const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";

// Ids deleted by a tombstone while a send for them was still queued. The
// outbox consults this set so a retry after the deletion cannot resurrect the
// message on the server (and for every other participant).
const localTombstones = new Set<string>();

export function markLocalTombstone(messageId: string): void {
	localTombstones.add(messageId);
}

export function isLocallyTombstoned(messageId: string): boolean {
	return localTombstones.has(messageId);
}

// Account switches must not leak tombstones into another account. The set is
// bounded by the session's deletions, so a plain clear is enough.
export function resetLocalTombstones(): void {
	localTombstones.clear();
}

type EnsureAccount = () => void;

// Each repository resolves the active database at call time. Checking before
// every store call keeps a long apply from starting a write after an account
// switch and placing one account's rows in another account's cache.
function accountGuard(expected: string | null): EnsureAccount {
	return () => {
		if (getActiveAccountKey() !== expected) {
			throw new Error("sync account changed");
		}
	};
}

// applyDelta folds a /api/sync response into the local IDB cache.
// It implements LWW conflict resolution: when the server reports a
// message edited at a later timestamp than the user's local queued
// edit, the local outbox op is dropped; otherwise the local edit
// will be replayed over the server copy on the next outbox tick.
export async function applyDelta(
	delta: SyncResponse,
	accountKey: string | null = getActiveAccountKey(),
): Promise<void> {
	const ensure = accountGuard(accountKey);
	const outbox = await outboxRepo.list();
	ensure();

	const chats = delta.chats ?? [];
	const deletedChats = delta.deletedChats ?? [];
	const messages = delta.messages ?? [];
	const threadMessages = delta.threadMessages ?? [];
	const deletedMessages = delta.deletedMessages ?? [];

	// The removals are applied before the chat list: a member who left a
	// group and came back is in the list again, and the chat must survive the
	// tombstone of the earlier removal.
	if (deletedChats.length > 0) {
		ensure();
		await chatsRepo.removeMany(deletedChats.map((d) => d.chatId));
	}

	if (chats.length > 0) {
		ensure();
		// A pin or unpin still queued locally must survive the server snapshot:
		// the delta was built before the op was delivered and would otherwise
		// revert the optimistic list.
		const pendingPinChats = new Set(
			outbox.filter((op) => op.kind === "pin").map((op) => op.chatId),
		);
		let chatsToStore = chats;
		if (pendingPinChats.size > 0) {
			chatsToStore = await Promise.all(
				chats.map(async (chat) => {
					if (!pendingPinChats.has(chat.id)) return chat;
					const local = await chatsRepo.getById(chat.id);
					return local === undefined
						? chat
						: { ...chat, pinnedMessageIds: local.pinnedMessageIds };
				}),
			);
		}
		await chatsRepo.upsertMany(chatsToStore);
	}

	if (delta.onlineStatus) {
		for (const [userId, online] of Object.entries(delta.onlineStatus)) {
			ensure();
			await chatsRepo.updateMemberStatus(userId, online);
		}
	}

	await applyMessages(messages, outbox, ensure);

	// The messages of the threads go into their own store: the chat feed
	// holds the top-level messages only. Thread records get the same
	// queued/failed guard and LWW resolution as top-level messages so a
	// parallel send in a thread is not clobbered by the delta.
	await applyThreadMessages(threadMessages, outbox, ensure);

	await applyDeletions(deletedMessages, outbox, ensure);
}

// applyMessages stores the chat messages of the delta, resolving the
// conflicts with the local outbox.
async function applyMessages(
	messages: Message[],
	outbox: OutboxOp[],
	ensure: EnsureAccount,
): Promise<void> {
	if (messages.length === 0) return;

	const stored: Message[] = [];

	for (const msg of messages) {
		ensure();
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
		ensure();
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
	ensure: EnsureAccount,
): Promise<void> {
	if (threadMessages.length === 0) return;

	const stored: { threadId: string; msg: Message }[] = [];
	// Ids that already existed locally: a delta replay must not count them as
	// new replies in the thread record.
	const localIds = new Set<string>();

	for (const msg of threadMessages) {
		if (msg.threadId === undefined) continue;

		ensure();
		const local = await threadMessagesRepo.getById(msg.threadId, msg.id);
		if (local !== undefined) localIds.add(`${msg.threadId}:${msg.id}`);

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
			ensure();
			await threadMessagesRepo.upsertMany(list, threadId);
			// The "N replies" link reads threads.messageCount: count a message
			// the first time it lands. A delta replay finds the row locally and
			// must not count it twice (see the `stored` push above).
			const known = list.filter((m) =>
				localIds.has(`${threadId}:${m.id}`),
			).length;
			const added = list.length - known;
			if (added > 0) await threadsRepo.bumpMessageCount(threadId, added);
		}
	}
}

// applyDeletions marks the deleted messages of the delta and cleans up the
// outbox operations that became redundant.
async function applyDeletions(
	deletedMessages: SyncResponse["deletedMessages"],
	outbox: OutboxOp[],
	ensure: EnsureAccount,
): Promise<void> {
	for (const d of deletedMessages) {
		ensure();
		// The tombstone wins over a queued send. Keeping the send (or merely
		// skipping the tombstone) would replay the message after the delete and
		// bring it back for every participant; the local tombstone also blocks
		// the outbox from retrying this id between this tick and the next one.
		markLocalTombstone(d.messageId);
		const sendOp = outbox.find(
			(o) => o.kind === "send" && o.msgId === d.messageId,
		);
		if (sendOp !== undefined && sendOp.kind === "send") {
			if (sendOp.pendingFileClientIds.length > 0) {
				await pendingBlobsRepo.deleteMany(sendOp.pendingFileClientIds);
			}
			await outboxRepo.remove(sendOp.opId);
		}

		// If we have a queued delete-op, it's now redundant — the
		// server already removed the message, so the op is a no-op.
		const deleteOp = outbox.find(
			(o) => o.kind === "delete" && o.messageId === d.messageId,
		);
		if (deleteOp !== undefined) {
			await outboxRepo.remove(deleteOp.opId);
		}

		// An edit, reaction or pin of a deleted message can never succeed:
		// replaying it would only fail with 404 and resurrect the row as
		// "failed". The tombstone wins, so the queued intent is dropped.
		await dropOpsForDeletedMessage(outbox, d.messageId);

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

async function forgetPinnedMessage(op: OutboxOpPin): Promise<void> {
	const chat = await chatsRepo.getById(op.chatId);
	if (chat === undefined) return;

	const pinned = (chat.pinnedMessageIds ?? []).filter(
		(id) => id !== op.messageId,
	);
	await chatsRepo.upsert({ ...chat, pinnedMessageIds: pinned });
}

// dropOpsForDeletedMessage removes the queued operations whose target was
// deleted elsewhere. Staged blobs of a dropped edit are released too: keeping
// them would leak storage with no operation left to upload them.
async function dropOpsForDeletedMessage(
	outbox: OutboxOp[],
	messageId: string,
): Promise<void> {
	for (const op of outbox) {
		if (op.kind === "edit" && op.messageId === messageId) {
			if (op.pendingFileClientIds.length > 0) {
				await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
			}
			await outboxRepo.remove(op.opId);
			continue;
		}

		if (op.kind === "pin" && op.messageId === messageId) {
			// The tombstone removes the pin server-side, so the local list
			// must lose the id in both directions. Reverting previousPinned
			// would re-pin a deleted message when the queued op was an unpin.
			await forgetPinnedMessage(op);
			await outboxRepo.remove(op.opId);
			continue;
		}

		if (op.kind === "reaction" && op.messageId === messageId) {
			await outboxRepo.remove(op.opId);
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
