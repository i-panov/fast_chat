import { useCallback } from "react";
import { fileExistsByHash } from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { type EncryptResult, encryptForChat } from "../e2ee/chat-encrypt.ts";
import {
	computePlaintextHash,
	encryptFileStream,
	type FileKey,
	generateFileKey,
} from "../e2ee/index.ts";
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
	sendMessage: (params: SendMessageParams) => Promise<void>;
	editMessage: (params: EditMessageParams) => Promise<void>;
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

interface PreparedFile {
	clientId: string;
	fileKey?: FileKey;
	plaintextHash: string;
	// onServer indicates the file already exists on the server (matched by
	// plaintext hash). No upload is needed; the message only needs the hash.
	onServer?: boolean;
}

// prepareFiles prepares each pending file for sending. It first checks whether
// the file already exists on the server (by plaintext hash) to skip the upload
// entirely. Files that exist on the server are recorded hash-only. Remaining
// files are encrypted (unless opted out) and stored as pending blobs for
// outbox upload.
async function prepareFiles(
	pending: PendingFile[],
	token: string | undefined,
): Promise<PreparedFile[]> {
	const out: PreparedFile[] = [];

	for (const pf of pending) {
		const clientId = genId();
		const plaintextHash = await computePlaintextHash(pf.file);

		// Check if the server already has this file to skip uploading.
		if (token !== undefined) {
			try {
				if (await fileExistsByHash(token, plaintextHash)) {
					out.push({ clientId, plaintextHash, onServer: true });
					continue;
				}
			} catch {
				// On any error, fall through to upload the file.
			}
		}

		if (pf.encrypted === false) {
			// Unencrypted: store plaintext blob, no file key.
			await pendingBlobsRepo.put({
				id: clientId,
				blob: pf.file,
				name: pf.originalName,
				mimeType: pf.mimeType,
				size: pf.size,
				plaintextHash,
				encrypted: false,
			});
			out.push({ clientId, plaintextHash });
			continue;
		}

		// Encrypted: generate file key, encrypt blob, store ciphertext.
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(pf.file, fileKey);

		await pendingBlobsRepo.put({
			id: clientId,
			blob: new Blob([ciphertext as unknown as ArrayBuffer]),
			name: pf.originalName,
			mimeType: pf.mimeType,
			size: pf.size,
			plaintextHash,
			encrypted: true,
		});
		out.push({ clientId, fileKey, plaintextHash });
	}

	return out;
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
	) => Promise<EncryptResult | null>;
	token: string | undefined;
}

async function doSendMessage(params: SendMessageParams, deps: SenderDeps) {
	const {
		chatId,
		text,
		pendingFiles,
		location,
		replyToId,
		threadId: inThreadId,
	} = params;
	const { user, token } = deps;
	if (user === null) return;

	const msgId = genId();
	const now = new Date().toISOString();

	// Prepare files: skip upload for files already on server (by hash).
	const prepared = await deps.prepareFiles(pendingFiles ?? [], token);
	const fileInfos: FileInfo[] = (pendingFiles ?? []).map(buildStoredFile);

	// Build fileKeys map: plaintextHash → key. Only encrypted files have a key.
	// Keyed by hash (not file ID) because the server assigns different IDs to
	// the same content, but the hash stays the same for sender and receiver.
	const fileKeys: Record<string, FileKey> = {};
	for (let i = 0; i < prepared.length; i++) {
		const key = prepared[i].fileKey;
		if (key !== undefined) {
			fileKeys[prepared[i].plaintextHash] = key;
		}
	}

	const encrypted = await deps.encryptForChat(
		token,
		chatId,
		{ text, location },
		fileKeys,
	);
	if (encrypted === null) return;

	const payload = JSON.stringify({
		v: 1,
		nonce: encrypted.nonce,
		envelopes: encrypted.envelopes,
	});

	// Files already on server are sent as hashes; the server resolves them
	// to existing file IDs. Other files are uploaded via the outbox.
	const fileHashes = prepared
		.filter((p) => p.onServer)
		.map((p) => p.plaintextHash);
	const uploadClientIds = prepared
		.filter((p) => !p.onServer)
		.map((p) => p.clientId);

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
}

async function doEditMessage(params: EditMessageParams, deps: SenderDeps) {
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
	const { token } = deps;

	const current = inThreadId
		? await threadMessagesRepo.getById(inThreadId, messageId)
		: await messagesRepo.getById(chatId, messageId);
	if (current === undefined) return;

	const blobIds = await deps.prepareFiles(pendingFiles ?? [], token);
	const newFileInfos: FileInfo[] = (pendingFiles ?? []).map(buildStoredFile);

	// Build fileKeys map for new files: plaintextHash → key.
	const fileKeys: Record<string, FileKey> = {};
	for (let i = 0; i < blobIds.length; i++) {
		const key = blobIds[i].fileKey;
		if (key !== undefined) {
			fileKeys[blobIds[i].plaintextHash] = key;
		}
	}

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

	const encrypted = await deps.encryptForChat(
		token,
		chatId,
		{ text, location: nextLocation },
		fileKeys,
	);
	if (encrypted === null) return;

	const payload = JSON.stringify({
		v: 1,
		nonce: encrypted.nonce,
		envelopes: encrypted.envelopes,
	});

	// Files already on server are sent as hashes; the server resolves them
	// to existing file IDs. Other files are uploaded via the outbox.
	const fileHashes = blobIds
		.filter((p) => p.onServer)
		.map((p) => p.plaintextHash);
	const uploadClientIds = blobIds
		.filter((p) => !p.onServer)
		.map((p) => p.clientId);

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
		clearLocation: false,
		clientEditedAt: now,
		createdAt: now,
		attempts: 0,
		threadId: inThreadId,
	});

	scheduleSync();
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
