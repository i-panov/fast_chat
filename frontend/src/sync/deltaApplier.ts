import { getSync, type Message, type SyncResponse } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp } from "../db/schema.ts";

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
	const deletedMessages = delta.deletedMessages ?? [];

	if (chats.length > 0) {
		await chatsRepo.upsertMany(chats);
	}

	if (deletedChats.length > 0) {
		await chatsRepo.removeMany(deletedChats.map((d) => d.chatId));
	}

	if (messages.length > 0) {
		const stored: Message[] = [];
		for (const msg of delta.messages) {
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
			if (
				editOp !== undefined &&
				editOp.kind === "edit" &&
				msg.editedAt !== undefined &&
				msg.editedAt > editOp.clientEditedAt
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
	}

	await metaRepo.setLastSyncedAt(delta.serverNow);
}

export async function pullDelta(
	token: string,
	since: string | null,
): Promise<SyncResponse> {
	return getSync(token, since ?? DEFAULT_SINCE);
}

// Filter out ops that the server-side delta just resolved, so the
// outbox doesn't try to replay them over fresh server state.
export function pruneResolvedOps(
	ops: OutboxOp[],
	delta: SyncResponse,
): OutboxOp[] {
	const deletedIds = new Set(
		(delta.deletedMessages ?? []).map((d) => d.messageId),
	);

	return ops.filter((op) => {
		if (op.kind === "delete" && deletedIds.has(op.messageId)) {
			return false;
		}
		return true;
	});
}
