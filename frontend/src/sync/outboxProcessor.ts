import { deleteMessage, editMessage, sendMessage, uploadFile } from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp, OutboxOpEdit, OutboxOpSend } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";

const RETRY_AFTER_REGEX = /retry-after:(.+)/;

const HTTP_STATUS_RE = /^http (\d{3})\b/;

export async function processOutbox(token: string): Promise<void> {
	const ops = await outboxRepo.list();

	for (const op of ops) {
		if (op.status === "failed") continue;

		try {
			await runOp(op, token);
		} catch (err) {
			if (isTransient(err)) {
				// Respect Retry-After headers (e.g. 429 rate limiting) by
				// backing off before the next sync tick. Default fallback
				// is handled by syncEngine's own debounce.
				const retryAfterMs = extractRetryAfterMs(err);
				if (retryAfterMs !== null) {
					await delay(retryAfterMs);
				}
				return;
			}
			await failOp(op, err);
		}
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOp(op: OutboxOp, token: string): Promise<void> {
	switch (op.kind) {
		case "send":
			await runSend(op, token);
			return;
		case "edit":
			await runEdit(op, token);
			return;
		case "delete":
			await runDelete(op, token);
			return;
	}
}

async function runSend(op: OutboxOpSend, token: string): Promise<void> {
	const uploadedIDs = await uploadPendingFiles(
		op.pendingFileClientIds,
		token,
		op,
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
			threadId: op.threadId,
			encrypted: op.encrypted,
			encryptedPayload: op.encryptedPayload,
		});
		await threadMessagesRepo.markStatus(op.threadId, op.msgId, "sent");
	} else {
		await sendMessage(token, {
			chatId: op.chatId,
			text: op.text,
			id: op.msgId,
			replyToId: op.replyToId,
			fileIDs: uploadedIDs.length > 0 ? uploadedIDs : undefined,
			fileHashes: op.fileHashes,
			encrypted: op.encrypted,
			encryptedPayload: op.encryptedPayload,
		});
		await messagesRepo.markStatus(op.chatId, op.msgId, "sent");
	}

	if (op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
	await outboxRepo.remove(op.opId);
}

async function runEdit(op: OutboxOpEdit, token: string): Promise<void> {
	const uploaded = await uploadPendingFiles(op.pendingFileClientIds, token, op);

	let fileIDs: string[] | undefined;
	if (uploaded.length > 0) {
		fileIDs = uploaded;
	} else if (op.keptFileIds.length > 0) {
		fileIDs = op.keptFileIds;
	} else {
		fileIDs = undefined;
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
): Promise<void> {
	try {
		// Thread messages are addressed by their real chat too: the server
		// resolves the container from the message, and the thread id is not a
		// chat, so sending it here would fail the membership check with 404.
		await deleteMessage(token, op.chatId, op.messageId);
	} catch (err) {
		if (isNotFound(err)) {
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
	if (op.threadId !== undefined) {
		await threadMessagesRepo.remove(op.threadId, op.messageId);
	} else {
		await messagesRepo.remove(op.chatId, op.messageId);
	}
	await outboxRepo.remove(op.opId);
}

async function failOp(op: OutboxOp, _err: unknown): Promise<void> {
	if (op.kind === "send" || op.kind === "edit") {
		const chatId = op.chatId;
		const messageId = op.kind === "send" ? op.msgId : op.messageId;
		if (op.threadId !== undefined) {
			await threadMessagesRepo.markStatus(op.threadId, messageId, "failed");
		} else {
			await messagesRepo.markStatus(chatId, messageId, "failed");
		}
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
		await outboxRepo.update({ ...op, uploadedFileIds: [...out] });
	}

	return out;
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
