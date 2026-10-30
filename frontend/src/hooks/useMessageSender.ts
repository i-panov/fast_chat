import { useCallback } from "react";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import {
	buildFileMaps,
	dropPreparedBlobs,
	type EncryptResult,
	encryptForChat,
	type PreparedFile,
	prepareFiles,
} from "../e2ee/chat-encrypt.ts";
import type { FileMeta } from "../e2ee/crypto.ts";
import type { FileKey } from "../e2ee/file-crypto.ts";
import { getMyKeyPair } from "../e2ee/keys.ts";
import { recoverKeptFileKeys } from "../e2ee/message.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import type {
	FileInfo,
	Location,
	Message,
	MessageStatus,
	PendingFile,
} from "../types/api.ts";
import { useAuth } from "../useAuth";

interface UseMessageSenderParams {
	token?: string;
}

interface SendMessageParams {
	chatId: string;
	text: string;
	pendingFiles?: PendingFile[];
	location?: Location;
	replyToId?: string;
	threadId?: string;
}

interface EditMessageParams {
	chatId: string;
	messageId: string;
	text: string;
	pendingFiles?: PendingFile[];
	location?: Location | null;
	clearLocation?: boolean;
	filesToRemove?: string[];
	threadId?: string;
}

interface UseMessageSenderReturn {
	// send/edit resolve to true when the op was enqueued and false when
	// encryption was skipped (e.g. missing keys). They throw only when
	// encryption itself fails, so the submit form can keep the draft.
	sendMessage: (params: SendMessageParams) => Promise<boolean>;
	editMessage: (params: EditMessageParams) => Promise<boolean>;
	deleteMessage: (
		chatId: string,
		messageId: string,
		threadId?: string,
	) => Promise<void>;
	retryMessage: (
		chatId: string,
		messageId: string,
		threadId?: string,
	) => Promise<void>;
	cancelSendMessage: (
		chatId: string,
		messageId: string,
		threadId?: string,
	) => Promise<void>;
}

function genId(): string {
	return crypto.randomUUID();
}

function statusForEdit(current: MessageStatus): MessageStatus {
	return current === "failed" ? "queued" : current;
}

function buildStoredFile(pf: PendingFile): FileInfo {
	return {
		id: pf.id,
		originalName: pf.originalName,
		size: pf.size,
		mimeType: pf.mimeType,
		fileType: pf.fileType,
		url: pf.blobUrl,
	};
}

interface SenderDeps {
	user: { id: string; nick: string } | null;
	prepareFiles: (
		pending: PendingFile[],
		token: string | undefined,
	) => Promise<PreparedFile[]>;
	encryptForChat: (
		token: string | undefined,
		chatId: string,
		content: { text: string; location?: Location },
		fileKeys: Record<string, FileKey>,
		fileMeta?: Record<string, FileMeta>,
	) => Promise<EncryptResult | null>;
	token: string | undefined;
}

// removeSendOrEditOp removes the pending send/edit op for a message together
// with its staged blobs (shared by the failed-delete and cancel paths).
async function removeSendOrEditOp(
	chatId: string,
	messageId: string,
): Promise<void> {
	const ops = await outboxRepo.list();
	const op = ops.find(
		(o) =>
			o.chatId === chatId &&
			((o.kind === "send" && o.msgId === messageId) ||
				(o.kind === "edit" && o.messageId === messageId)),
	);
	if (op !== undefined && op.kind !== "delete") {
		if (op.pendingFileClientIds.length > 0) {
			await pendingBlobsRepo.deleteMany(op.pendingFileClientIds);
		}
		await outboxRepo.remove(op.opId);
	}
}

// encryptContentOrCleanup encrypts via deps and, when encryption throws,
// drops the staged blobs before rethrowing so failures leave no orphans.
async function encryptContentOrCleanup(
	deps: SenderDeps,
	prepared: PreparedFile[],
	token: string | undefined,
	chatId: string,
	content: { text: string; location?: Location },
	fileKeys: Record<string, FileKey>,
	fileMeta?: Record<string, FileMeta>,
): Promise<EncryptResult | null> {
	try {
		return await deps.encryptForChat(
			token,
			chatId,
			content,
			fileKeys,
			fileMeta,
		);
	} catch (err) {
		await dropPreparedBlobs(prepared);
		throw err;
	}
}

async function doSendMessage(
	params: SendMessageParams,
	deps: SenderDeps,
): Promise<boolean> {
	const {
		chatId,
		text,
		pendingFiles,
		location,
		replyToId,
		threadId: inThreadId,
	} = params;
	const { user, token } = deps;
	if (user === null) return false;

	const msgId = genId();
	const now = new Date().toISOString();

	// Prepare files: skip upload for files already on server (by hash).
	// Keys are indexed by plaintext hash (not file ID) because the server
	// assigns different IDs to the same content on each side.
	const prepared = await deps.prepareFiles(pendingFiles ?? [], token);
	const fileInfos: FileInfo[] = (pendingFiles ?? []).map(buildStoredFile);
	const { fileKeys, fileMeta, fileHashes, uploadClientIds } =
		buildFileMaps(prepared);

	const encrypted = await encryptContentOrCleanup(
		deps,
		prepared,
		token,
		chatId,
		{ text, location },
		fileKeys,
		fileMeta,
	);
	if (encrypted === null) {
		// Encryption did not run (e.g. missing keys): drop the staged blobs
		// so they do not linger as orphans in IDB.
		await dropPreparedBlobs(prepared);
		return false;
	}

	const payload = JSON.stringify({
		v: 1,
		nonce: encrypted.nonce,
		envelopes: encrypted.envelopes,
	});

	const stored: Message = {
		id: msgId,
		chatId,
		fromId: user.id,
		fromNick: user.nick,
		text: encrypted.ciphertext,
		encrypted: true,
		encryptedPayload: payload,
		createdAt: now,
		editedAt: undefined,
		replyTo: undefined,
		files: fileInfos.length > 0 ? fileInfos : undefined,
		location: undefined, // location is now inside encrypted content
	};

	if (inThreadId !== undefined) {
		await threadMessagesRepo.upsert(stored, inThreadId, "queued");
	} else {
		await messagesRepo.upsert(stored, "queued");
	}

	await outboxRepo.enqueue({
		kind: "send",
		opId: genId(),
		chatId,
		msgId,
		text: encrypted.ciphertext,
		encrypted: true,
		encryptedPayload: payload,
		replyToId,
		pendingFileClientIds: uploadClientIds,
		fileHashes,
		createdAt: now,
		attempts: 0,
		threadId: inThreadId,
	});

	scheduleSync();
	return true;
}

async function doEditMessage(
	params: EditMessageParams,
	deps: SenderDeps,
): Promise<boolean> {
	const {
		chatId,
		messageId,
		text,
		pendingFiles,
		location,
		clearLocation,
		filesToRemove,
		threadId: inThreadId,
	} = params;
	const { token, user } = deps;

	const current = inThreadId
		? await threadMessagesRepo.getById(inThreadId, messageId)
		: await messagesRepo.getById(chatId, messageId);
	if (current === undefined) return false;

	const blobIds = await deps.prepareFiles(pendingFiles ?? [], token);
	const newFileInfos: FileInfo[] = (pendingFiles ?? []).map(buildStoredFile);
	const {
		fileKeys: newKeys,
		fileMeta: newMeta,
		fileHashes,
		uploadClientIds,
	} = buildFileMaps(blobIds);

	// Kept files must stay decryptable after the edit: recover the previous
	// content's fileKeys/fileMeta (keyed by plaintext hash) and merge them
	// under the new files' entries. Unknown removed hashes simply leave
	// harmless extra keys behind; missing keys would break recipients.
	const kept =
		user !== null
			? await recoverKeptFileKeys(current, user.id, await getMyKeyPair())
			: { fileKeys: {}, fileMeta: {} };
	const fileKeys = { ...kept.fileKeys, ...newKeys };
	const fileMeta = { ...kept.fileMeta, ...newMeta };

	const removeSet = new Set(filesToRemove ?? []);
	const keptFileIds: string[] = (current.files ?? [])
		.filter((f) => !removeSet.has(f.id))
		.map((f) => f.id);
	const keptFiles: FileInfo[] = (current.files ?? []).filter(
		(f) => !removeSet.has(f.id),
	);
	const mergedFiles: FileInfo[] | undefined =
		newFileInfos.length > 0
			? [...keptFiles, ...newFileInfos]
			: keptFiles.length > 0
				? keptFiles
				: undefined;

	const now = new Date().toISOString();
	const nextLocation: Location | undefined =
		clearLocation === true ? undefined : (location ?? current.location);

	const nextStatus = statusForEdit(
		current.status === "deleted" ? "sent" : current.status,
	);
	const { status: _ignored, _updatedAt: _u, ...base } = current;
	void _ignored;
	void _u;

	const encrypted = await encryptContentOrCleanup(
		deps,
		blobIds,
		token,
		chatId,
		{ text, location: nextLocation },
		fileKeys,
		fileMeta,
	);
	if (encrypted === null) {
		await dropPreparedBlobs(blobIds);
		return false;
	}

	const payload = JSON.stringify({
		v: 1,
		nonce: encrypted.nonce,
		envelopes: encrypted.envelopes,
	});

	const updated: Message = {
		...base,
		text: encrypted.ciphertext,
		encrypted: true,
		encryptedPayload: payload,
		files: mergedFiles,
		location: undefined, // location is now inside encrypted content
		editedAt: now,
	};

	if (inThreadId !== undefined) {
		await threadMessagesRepo.upsert(updated, inThreadId, nextStatus);
	} else {
		await messagesRepo.upsert(updated, nextStatus);
	}

	await outboxRepo.enqueue({
		kind: "edit",
		opId: genId(),
		chatId,
		messageId,
		text: encrypted.ciphertext,
		encrypted: true,
		encryptedPayload: payload,
		pendingFileClientIds: uploadClientIds,
		fileHashes,
		keptFileIds,
		filesToRemove: filesToRemove ?? [],
		clearLocation: clearLocation === true,
		clientEditedAt: now,
		createdAt: now,
		attempts: 0,
		threadId: inThreadId,
	});

	scheduleSync();
	return true;
}

async function doDeleteMessage(
	chatId: string,
	messageId: string,
	threadId?: string,
) {
	const current = threadId
		? await threadMessagesRepo.getById(threadId, messageId)
		: await messagesRepo.getById(chatId, messageId);

	if (current?.status === "failed") {
		await removeSendOrEditOp(chatId, messageId);
		if (threadId !== undefined) {
			await threadMessagesRepo.remove(threadId, messageId);
		} else {
			await messagesRepo.remove(chatId, messageId);
		}
	} else {
		if (current !== undefined) {
			if (threadId !== undefined) {
				await threadMessagesRepo.applyDelete(threadId, messageId);
			} else {
				await messagesRepo.applyDelete(chatId, messageId);
			}
		}
		await outboxRepo.enqueue({
			kind: "delete",
			opId: genId(),
			chatId,
			messageId,
			createdAt: new Date().toISOString(),
			attempts: 0,
			threadId,
		});
	}

	scheduleSync();
}

async function doRetryMessage(
	chatId: string,
	messageId: string,
	threadId?: string,
) {
	const current = threadId
		? await threadMessagesRepo.getById(threadId, messageId)
		: await messagesRepo.getById(chatId, messageId);
	if (current === undefined) return;

	const ops = await outboxRepo.list();
	const op = ops.find(
		(o) =>
			o.status === "failed" &&
			o.chatId === chatId &&
			((o.kind === "send" && o.msgId === messageId) ||
				(o.kind === "edit" && o.messageId === messageId)),
	);
	if (op !== undefined) {
		op.status = undefined;
		op.attempts = 0;
		await outboxRepo.update(op);
	}

	if (threadId !== undefined) {
		await threadMessagesRepo.markStatus(threadId, messageId, "queued");
	} else {
		await messagesRepo.markStatus(chatId, messageId, "queued");
	}
	scheduleSync();
}

async function doCancelSendMessage(
	chatId: string,
	messageId: string,
	threadId?: string,
) {
	const current = threadId
		? await threadMessagesRepo.getById(threadId, messageId)
		: await messagesRepo.getById(chatId, messageId);
	if (current === undefined) return;
	if (current.status !== "queued" && current.status !== "failed") return;

	await removeSendOrEditOp(chatId, messageId);

	if (threadId !== undefined) {
		await threadMessagesRepo.remove(threadId, messageId);
	} else {
		await messagesRepo.remove(chatId, messageId);
	}
}

export function useMessageSender({
	token,
}: UseMessageSenderParams): UseMessageSenderReturn {
	const { activeAccount } = useAuth();
	const user = activeAccount?.user ?? null;

	const sendMessage = useCallback(
		(params: SendMessageParams) =>
			doSendMessage(params, {
				user,
				prepareFiles,
				encryptForChat,
				token,
			}),
		[user, token],
	);

	const editMessage = useCallback(
		(params: EditMessageParams) =>
			doEditMessage(params, {
				user,
				prepareFiles,
				encryptForChat,
				token,
			}),
		[user, token],
	);

	const deleteMessage = useCallback(
		(chatId: string, messageId: string, threadId?: string) =>
			doDeleteMessage(chatId, messageId, threadId),
		[],
	);

	const retryMessage = useCallback(
		(chatId: string, messageId: string, threadId?: string) =>
			doRetryMessage(chatId, messageId, threadId),
		[],
	);

	const cancelSendMessage = useCallback(
		(chatId: string, messageId: string, threadId?: string) =>
			doCancelSendMessage(chatId, messageId, threadId),
		[],
	);

	return {
		sendMessage,
		editMessage,
		deleteMessage,
		retryMessage,
		cancelSendMessage,
	};
}
