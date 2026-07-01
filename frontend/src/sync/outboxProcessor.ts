import {
	deleteMessage,
	editMessage,
	editThreadMessage,
	sendMessage,
	sendThreadMessage,
	uploadFile,
} from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp, OutboxOpEdit, OutboxOpSend } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";

export async function processOutbox(token: string): Promise<void> {
	const ops = await outboxRepo.list();

	for (const op of ops) {
		if (op.status === "failed") continue;

		try {
			await runOp(op, token);
		} catch (err) {
			if (isTransient(err)) {
				return;
			}
			await failOp(op, err);
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

	if (op.threadId !== undefined) {
		await sendThreadMessage(
			token,
			op.chatId,
			op.threadId,
			op.text,
			op.msgId,
			op.replyToId,
			fileIDs.length > 0 ? fileIDs : undefined,
			op.location,
		);
		await threadMessagesRepo.markStatus(op.threadId, op.msgId, "sent");
	} else {
		await sendMessage(
			token,
			op.chatId,
			op.text,
			op.msgId,
			op.replyToId,
			fileIDs.length > 0 ? fileIDs : undefined,
			op.location,
		);
		await messagesRepo.markStatus(op.chatId, op.msgId, "sent");
	}

	if (op.pendingFileClientIds.length > 0) {
		await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
	}
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

	const editOpts = {
		location: op.location ?? undefined,
		clearLocation: op.clearLocation,
	};

	if (op.threadId !== undefined) {
		await editThreadMessage(
			token,
			op.chatId,
			op.threadId,
			op.messageId,
			op.text,
			fileIDs,
			editOpts,
		);
		await threadMessagesRepo.markStatus(op.threadId, op.messageId, "sent");
	} else {
		await editMessage(
			token,
			op.chatId,
			op.messageId,
			op.text,
			fileIDs,
			editOpts,
		);
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
		// For thread messages, the server expects threadId as chatId
		// in the DELETE /api/chats/{chatId}/messages/{messageId} endpoint.
		const deleteChatId = op.threadId ?? op.chatId;
		await deleteMessage(token, deleteChatId, op.messageId);
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
	if (op.kind === "delete") {
		if (op.threadId !== undefined) {
			await threadMessagesRepo.remove(op.threadId, op.messageId);
		} else {
			await messagesRepo.remove(op.chatId, op.messageId);
		}
	}
	await outboxRepo.update({ ...op, status: "failed" as const });
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
