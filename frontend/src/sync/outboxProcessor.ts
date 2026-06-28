import { deleteMessage, editMessage, sendMessage, uploadFile } from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp, OutboxOpEdit, OutboxOpSend } from "../db/schema.ts";

// processOutbox drains the outbox in chronological order. Each op
// either succeeds, fails transiently (left in outbox for retry), or
// fails terminally (dropped from outbox + UI). Network errors stop
// the loop so the next sync tick can resume from the same position.
export async function processOutbox(token: string): Promise<void> {
	const ops = await outboxRepo.list();

	for (const op of ops) {
		try {
			await runOp(op, token);
		} catch (err) {
			if (isTransient(err)) {
				// Network/server hiccup: leave the op in the outbox
				// and abort the rest. The next tick will retry.
				return;
			}
			// Terminal error (4xx, validation, etc.): drop the op
			// and any pending files it owns so we don't loop on it.
			await failOp(op, err);
			return;
		}
	}
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
	const fileIDs = await uploadPendingFiles(op.pendingFileClientIds, token);

	await sendMessage(
		token,
		op.chatId,
		op.text,
		op.msgId,
		op.replyToId,
		fileIDs.length > 0 ? fileIDs : undefined,
		op.location,
	);

	if (op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
	await messagesRepo.markStatus(op.chatId, op.msgId, "sent");
	await outboxRepo.remove(op.opId);
}

async function runEdit(op: OutboxOpEdit, token: string): Promise<void> {
	const uploaded = await uploadPendingFiles(op.pendingFileClientIds, token);

	let fileIDs: string[] | undefined;
	if (uploaded.length > 0) {
		fileIDs = uploaded;
	} else if (op.keptFileIds.length > 0) {
		fileIDs = op.keptFileIds;
	} else {
		fileIDs = undefined;
	}

	await editMessage(token, op.chatId, op.messageId, op.text, fileIDs, {
		location: op.location ?? undefined,
		clearLocation: op.clearLocation,
	});

	if (op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
	await messagesRepo.markStatus(op.chatId, op.messageId, "sent");
	await outboxRepo.remove(op.opId);
}

async function runDelete(
	op: Extract<OutboxOp, { kind: "delete" }>,
	token: string,
): Promise<void> {
	try {
		await deleteMessage(token, op.chatId, op.messageId);
	} catch (err) {
		// The server may have already dropped the message (out-of-band
		// delete from another tab/device, or an older sync tick). The
		// desired end state — message gone — is achieved either way,
		// so swallow 404-shaped errors and remove the op.
		if (isNotFound(err)) {
			await messagesRepo.remove(op.chatId, op.messageId);
			await outboxRepo.remove(op.opId);
			return;
		}
		throw err;
	}
	await messagesRepo.remove(op.chatId, op.messageId);
	await outboxRepo.remove(op.opId);
}

async function failOp(op: OutboxOp, _err: unknown): Promise<void> {
	if (op.kind !== "delete" && op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
	if (op.kind === "send" || op.kind === "edit") {
		const chatId = op.chatId;
		const messageId = op.kind === "send" ? op.msgId : op.messageId;
		await messagesRepo.markStatus(chatId, messageId, "failed");
	}
	if (op.kind === "delete") {
		await messagesRepo.remove(op.chatId, op.messageId);
	}
	await outboxRepo.remove(op.opId);
}

async function uploadPendingFiles(
	clientIds: string[],
	token: string,
): Promise<string[]> {
	const out: string[] = [];

	for (const cid of clientIds) {
		const pending = await pendingBlobsRepo.get(cid);
		if (pending === undefined) continue;

		const file = new File([pending.blob], pending.name, {
			type: pending.mimeType,
		});
		const { file: uploaded } = await uploadFile(token, file);
		out.push(uploaded.id);
	}

	return out;
}

function isTransient(err: unknown): boolean {
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		if (msg === "unauthorized") return false;
		if (msg.startsWith("http ")) {
			const code = Number(msg.split(" ")[1]);
			return code === 0 || code >= 500;
		}
		return true;
	}
	return true;
}

function isNotFound(err: unknown): boolean {
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		return msg === "http 404" || msg === "message not found";
	}
	return false;
}
