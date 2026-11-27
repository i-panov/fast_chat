import {
	addMessageReaction,
	deleteMessage,
	editMessage,
	markMessagesRead,
	pinMessage,
	removeMessageReaction,
	sendMessage,
	unpinMessage,
	uploadFile,
} from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { getActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type {
	OutboxOp,
	OutboxOpEdit,
	OutboxOpPin,
	OutboxOpSend,
} from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { isLocallyTombstoned } from "./deltaApplier.ts";

const RETRY_AFTER_REGEX = /retry-after:(.+)/;

const HTTP_STATUS_RE = /^http (\d{3})\b/;

// OutboxResult tells the caller whether the queue drained. A transient
// failure pauses it and carries the server's Retry-After. The caller owns the
// retry timer: sleeping inside the sync Web Lock would block every tab.
export interface OutboxResult {
	completed: boolean;
	retryAfterMs: number | null;
}

export async function processOutbox(token: string): Promise<OutboxResult> {
	// Every write below resolves the active database lazily. Pin the account
	// for this run and abort before a store call once it changes, so ops,
	// statuses and uploadedFileIds never land in another account's DB.
	const accountKey = getActiveAccountKey();
	ensureAccount(accountKey);
	await reconcileOrphanedSends(accountKey);
	const ops = await outboxRepo.list();
	ensureAccount(accountKey);

	for (const op of ops) {
		if (op.status === "failed") continue;

		try {
			ensureAccount(accountKey);
			await runOp(op, token, accountKey);
			ensureAccount(accountKey);
		} catch (err) {
			// An expired session is not a property of the queued operation:
			// fail it only if the server rejected the operation itself. The
			// caller re-authenticates and the queue survives.
			if (isUnauthorized(err)) throw err;
			if (isTransient(err)) {
				return {
					completed: false,
					retryAfterMs: extractRetryAfterMs(err),
				};
			}
			ensureAccount(accountKey);
			await failOp(op, err);
		}
	}

	return { completed: true, retryAfterMs: null };
}

function ensureAccount(accountKey: string | null): void {
	if (getActiveAccountKey() !== accountKey) {
		throw new Error("sync account changed");
	}
}

// A crash between the local row write and outboxRepo.enqueue leaves a bubble
// stuck in "sending" with no operation that could ever finish it. Rows older
// than the grace period (the write and the enqueue are milliseconds apart) are
// marked failed so the UI offers retry/cancel instead of spinning forever.
const ORPHAN_SEND_GRACE_MS = 30_000;

async function reconcileOrphanedSends(
	accountKey: string | null,
): Promise<void> {
	const queued = await messagesRepo.getPending();
	if (queued.length === 0) return;
	const ops = await outboxRepo.list();
	const pendingSendIds = new Set(
		ops.flatMap((o) => (o.kind === "send" ? [o.msgId] : [])),
	);
	const cutoff = Date.now() - ORPHAN_SEND_GRACE_MS;
	for (const message of queued) {
		if (pendingSendIds.has(message.id)) continue;
		const updatedAt = new Date(
			message._updatedAt ?? message.createdAt,
		).getTime();
		if (Number.isNaN(updatedAt) || updatedAt > cutoff) continue;
		ensureAccount(accountKey);
		await messagesRepo.markStatus(message.chatId, message.id, "failed");
	}
}

export function extractRetryAfterMs(err: unknown): number | null {
	if (!(err instanceof Error)) return null;
	const match = RETRY_AFTER_REGEX.exec(err.message);
	if (match === null) return null;

	const raw = match[1].trim();

	// Numeric form: seconds until retry.
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds > 0) {
		return Math.min(seconds * 1000, 5 * 60 * 1000);
	}

	// HTTP-date form: absolute timestamp until retry.
	const date = new Date(raw);
	if (!Number.isNaN(date.getTime())) {
		const delta = date.getTime() - Date.now();
		if (delta > 0) {
			return Math.min(delta, 5 * 60 * 1000);
		}
	}

	return null;
}

async function runOp(
	op: OutboxOp,
	token: string,
	accountKey: string | null,
): Promise<void> {
	switch (op.kind) {
		case "send":
			await runSend(op, token, accountKey);
			return;
		case "edit":
			await runEdit(op, token, accountKey);
			return;
		case "delete":
			await runDelete(op, token, accountKey);
			return;
		case "reaction":
			if (op.action === "add") {
				await addMessageReaction(token, op.chatId, op.messageId, op.emoji);
			} else {
				await removeMessageReaction(token, op.chatId, op.messageId, op.emoji);
			}
			await outboxRepo.remove(op.opId);
			return;
		case "pin":
			if (op.pinned) await pinMessage(token, op.chatId, op.messageId);
			else await unpinMessage(token, op.chatId, op.messageId);
			await outboxRepo.remove(op.opId);
			return;
		case "read":
			await markMessagesRead(token, op.chatId, op.messageIds);
			await outboxRepo.remove(op.opId);
			return;
	}
}

async function runSend(
	op: OutboxOpSend,
	token: string,
	accountKey: string | null,
): Promise<void> {
	// A tombstone applied while this send waited in the queue deletes the
	// message; sending it now would recreate it server-side and revive it for
	// everyone. Drop the operation together with its staged blobs.
	if (isLocallyTombstoned(op.msgId)) {
		if (op.pendingFileClientIds.length > 0) {
			await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
		}
		if (op.threadId !== undefined) {
			await threadMessagesRepo.applyDelete(op.threadId, op.msgId);
		} else {
			await messagesRepo.applyDelete(op.chatId, op.msgId);
		}
		await outboxRepo.remove(op.opId);
		return;
	}
	const uploadedIDs = await uploadPendingFiles(
		op.pendingFileClientIds,
		token,
		op,
		accountKey,
	);

	// fileHashes are files already on the server (matched by plaintext hash).
	// The server resolves them to existing file IDs.
	if (op.threadId !== undefined) {
		await sendMessage(token, {
			chatId: op.chatId,
			text: op.text,
			id: op.msgId,
			replyToId: op.replyToId,
			fileIDs: uploadedIDs.length > 0 ? uploadedIDs : undefined,
			fileHashes: op.fileHashes,
			location: op.location,
			threadId: op.threadId,
			encrypted: op.encrypted,
			encryptedPayload: op.encryptedPayload,
		});
		ensureAccount(accountKey);
		await threadMessagesRepo.markStatus(op.threadId, op.msgId, "sent");
	} else {
		await sendMessage(token, {
			chatId: op.chatId,
			text: op.text,
			id: op.msgId,
			replyToId: op.replyToId,
			fileIDs: uploadedIDs.length > 0 ? uploadedIDs : undefined,
			fileHashes: op.fileHashes,
			location: op.location,
			encrypted: op.encrypted,
			encryptedPayload: op.encryptedPayload,
		});
		ensureAccount(accountKey);
		await messagesRepo.markStatus(op.chatId, op.msgId, "sent");
	}

	if (op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
	await outboxRepo.remove(op.opId);
}

async function runEdit(
	op: OutboxOpEdit,
	token: string,
	accountKey: string | null,
): Promise<void> {
	// An edit of a message whose send is still queued or failed cannot
	// succeed: the server has no row to edit and would 404. Leave the edit
	// queued — a later tick runs it after a successful send — instead of
	// dropping it or deleting the delivered message.
	const pending = await outboxRepo.list();
	if (pending.some((o) => o.kind === "send" && o.msgId === op.messageId)) {
		return;
	}
	try {
		await pushEdit(op, token, accountKey);
	} catch (err) {
		if (!isNotFound(err)) throw err;
		await dropEditOfDeletedMessage(op);
	}
}

// The message was deleted on another device while this edit waited in the
// queue, so the edit can never be applied. The row itself is left alone: the
// server tombstone (delta or SSE) is the only confirmation that the message is
// gone, and removing it locally here would hide a live message until the next
// sync.
async function dropEditOfDeletedMessage(op: OutboxOpEdit): Promise<void> {
	if (op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
	if (op.threadId !== undefined) {
		await threadMessagesRepo.markStatus(op.threadId, op.messageId, "sent");
	} else {
		await messagesRepo.markStatus(op.chatId, op.messageId, "sent");
	}
	await outboxRepo.remove(op.opId);
}

async function pushEdit(
	op: OutboxOpEdit,
	token: string,
	accountKey: string | null,
): Promise<void> {
	const uploaded = await uploadPendingFiles(
		op.pendingFileClientIds,
		token,
		op,
		accountKey,
	);

	let fileIDs: string[] | undefined;
	if (
		uploaded.length > 0 ||
		op.keptFileIds.length > 0 ||
		op.filesToRemove.length > 0
	) {
		fileIDs = [...op.keptFileIds, ...uploaded];
	}

	if (op.threadId !== undefined) {
		await editMessage(token, {
			chatId: op.chatId,
			messageId: op.messageId,
			text: op.text,
			fileIDs,
			fileHashes: op.fileHashes,
			opts: { clearLocation: op.clearLocation },
			threadId: op.threadId,
			encrypted: op.encrypted,
			encryptedPayload: op.encryptedPayload,
		});
		ensureAccount(accountKey);
		await threadMessagesRepo.markStatus(op.threadId, op.messageId, "sent");
	} else {
		await editMessage(token, {
			chatId: op.chatId,
			messageId: op.messageId,
			text: op.text,
			fileIDs,
			fileHashes: op.fileHashes,
			opts: { clearLocation: op.clearLocation },
			encrypted: op.encrypted,
			encryptedPayload: op.encryptedPayload,
		});
		ensureAccount(accountKey);
		await messagesRepo.markStatus(op.chatId, op.messageId, "sent");
	}

	if (op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
	await outboxRepo.remove(op.opId);
}

async function runDelete(
	op: Extract<OutboxOp, { kind: "delete" }>,
	token: string,
	accountKey: string | null,
): Promise<void> {
	try {
		// Thread messages are addressed by their real chat too: the server
		// resolves the container from the message, and the thread id is not a
		// chat, so sending it here would fail the membership check with 404.
		await deleteMessage(token, op.chatId, op.messageId);
	} catch (err) {
		if (isNotFound(err)) {
			ensureAccount(accountKey);
			if (op.threadId !== undefined) {
				await threadMessagesRepo.remove(op.threadId, op.messageId);
			} else {
				await messagesRepo.remove(op.chatId, op.messageId);
			}
			await outboxRepo.remove(op.opId);
			return;
		}
		throw err;
	}
	ensureAccount(accountKey);
	if (op.threadId !== undefined) {
		await threadMessagesRepo.remove(op.threadId, op.messageId);
	} else {
		await messagesRepo.remove(op.chatId, op.messageId);
	}
	await outboxRepo.remove(op.opId);
}

// revertPin restores the optimistic pinned list of a chat. It is shared with
// the delta applier: a tombstone that drops a queued pin must undo the same
// optimistic entry.
async function revertPin(op: OutboxOpPin): Promise<void> {
	const chat = await chatsRepo.getById(op.chatId);
	if (chat === undefined) return;

	const current = chat.pinnedMessageIds ?? [];
	const pinned =
		op.previousPinned === true
			? [op.messageId, ...current.filter((id) => id !== op.messageId)]
			: current.filter((id) => id !== op.messageId);
	await chatsRepo.upsert({ ...chat, pinnedMessageIds: pinned });
}

async function failOp(op: OutboxOp, _err: unknown): Promise<void> {
	if (op.kind === "pin") {
		await revertPin(op);
	}
	if (op.kind === "reaction") {
		if (op.threadId !== undefined) {
			await threadMessagesRepo.updateReactions(
				op.threadId,
				op.messageId,
				op.previousReactions,
			);
		} else {
			await messagesRepo.updateReactions(
				op.chatId,
				op.messageId,
				op.previousReactions,
			);
		}
	}
	if (op.kind === "send" || op.kind === "edit") {
		const chatId = op.chatId;
		const messageId = op.kind === "send" ? op.msgId : op.messageId;
		if (op.threadId !== undefined) {
			await threadMessagesRepo.markStatus(op.threadId, messageId, "failed");
		} else {
			await messagesRepo.markStatus(chatId, messageId, "failed");
		}
	}
	if (op.kind === "reaction" || op.kind === "pin" || op.kind === "read") {
		// These are idempotent UI state changes with a bounded retry budget:
		// once terminally rejected, drop them instead of retrying every
		// reconnect forever. Optimistic state above is reverted first.
		await outboxRepo.remove(op.opId);
		return;
	}
	// A definitively failed delete keeps the local row: removing it locally
	// while the server kept it resurrects the message as a ghost on the
	// next delta. The row disappears only on success or 404 (runDelete).
	await outboxRepo.update({ ...op, status: "failed" as const });
}

async function uploadPendingFiles(
	clientIds: string[],
	token: string,
	op: OutboxOpSend | OutboxOpEdit,
	accountKey: string | null,
): Promise<string[]> {
	// Resume from previously persisted uploads so a retry after a crash
	// does not re-upload the same blobs and orphan them on the server.
	// uploadedFileIds holds server ids in upload order, so the resume is
	// positional; a longer-than-expected list means the op shape changed
	// under us — fall back to a full upload rather than skipping files.
	const persisted = op.uploadedFileIds ?? [];
	const resumable = persisted.length <= clientIds.length;
	const out: string[] = resumable ? [...persisted] : [];
	const remaining = resumable ? clientIds.slice(persisted.length) : clientIds;

	for (const cid of remaining) {
		const pending = await pendingBlobsRepo.get(cid);
		if (pending === undefined) {
			// A vanished staged blob would otherwise send the message with
			// a silently trimmed file set. Fail definitively (400-range,
			// non-transient) so failOp marks the message failed.
			throw new Error(`http 400: missing pending blob ${cid}`);
		}

		const file = new File([pending.blob], pending.name, {
			type: pending.mimeType,
		});
		// Encrypted blobs need the client hash + encrypted flag so the server
		// can deduplicate. The hash was computed before encryption and stored
		// alongside the blob.
		const { file: uploaded } = await uploadFile(
			token,
			file,
			pending.plaintextHash,
			pending.encrypted !== false,
		);
		out.push(uploaded.id);
		// Persist after every upload so a crash between uploads resumes
		// instead of re-uploading.
		ensureAccount(accountKey);
		await outboxRepo.update({ ...op, uploadedFileIds: [...out] });
	}

	return out;
}

function isUnauthorized(err: unknown): boolean {
	return err instanceof Error && err.message.toLowerCase() === "unauthorized";
}

function isTransient(err: unknown): boolean {
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		if (msg === "unauthorized") return false;
		const statusMatch = HTTP_STATUS_RE.exec(msg);
		if (statusMatch !== null) {
			const code = Number(statusMatch[1]);
			// 429 Too Many Requests is transient; other 4xx are terminal.
			// 5xx are transient too.
			return code >= 500 || code === 429;
		}
		// Network errors (fetch failed, DNS, etc.) are transient.
		return true;
	}
	return true;
}

function isNotFound(err: unknown): boolean {
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		// api.ts reports errors as "http <status>: ...", so match the 404
		// status instead of the whole string. Keep the legacy plain-text
		// match for older "message not found" errors.
		const statusMatch = HTTP_STATUS_RE.exec(msg);
		if (statusMatch !== null) return Number(statusMatch[1]) === 404;
		return msg.includes("message not found");
	}
	return false;
}
