import { useCallback } from "react";
import { chatsRepo } from "../db/chatsRepo.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { ensureAccountKeys, getRecipientPublicKeys } from "../e2ee/keys.ts";
import { encryptMessageText } from "../e2ee/message.ts";
import i18n from "../i18n.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import type {
	FileInfo,
	Location,
	Message,
	MessageStatus,
	PendingFile,
} from "../types/api.ts";
import { useAuth } from "../useAuth";
import { emitNotification } from "../utils/notify.ts";

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

export function useMessageSender({
	token,
}: UseMessageSenderParams): UseMessageSenderReturn {
	const { activeAccount } = useAuth();
	const user = activeAccount?.user ?? null;

	const enqueuePendingBlobs = useCallback(
		async (pending: PendingFile[]): Promise<string[]> => {
			const ids: string[] = [];
			for (const pf of pending) {
				const cid = genId();
				await pendingBlobsRepo.put({
					id: cid,
					blob: pf.file,
					name: pf.originalName,
					mimeType: pf.mimeType,
					size: pf.size,
				});
				ids.push(cid);
			}
			return ids;
		},
		[],
	);

	const encryptForChat = useCallback(
		async (
			chatId: string,
			text: string,
		): Promise<{ text: string; encryptedPayload: string } | null> => {
			try {
				const chat = await chatsRepo.getById(chatId);
				if (chat === undefined || token === undefined) return null;

				const memberIds = chat.members.map((m) => m.id);
				if (memberIds.length === 0) {
					throw new Error("chat has no members");
				}
				await ensureAccountKeys(token);

				const recipientKeys = await getRecipientPublicKeys(token, memberIds);
				const recipients: Array<{ keyId: string; publicKey: string }> = [];
				const missing: string[] = [];

				for (const id of memberIds) {
					const publicKey = recipientKeys.get(id);
					if (publicKey && publicKey !== "") {
						recipients.push({ keyId: id, publicKey });
					} else {
						missing.push(id);
					}
				}

				if (recipients.length === 0) {
					throw new Error("no recipient keys available");
				}

				if (missing.length > 0) {
					// Show which members block the message so the user
					// knows who needs to log in with E2E enabled.
					const nicks = chat.members
						.filter((m) => missing.includes(m.id))
						.map((m) => `@${m.nick}`)
						.join(", ");
					emitNotification(
						nicks !== ""
							? i18n.t("error.encryptionKeyMissingMembers", { members: nicks })
							: i18n.t("error.encryptionKeyMissing"),
					);
					return null;
				}

				return encryptMessageText(text, recipients);
			} catch {
				emitNotification(i18n.t("error.encryptionKeyMissing"));
				return null;
			}
		},
		[token],
	);

	const sendMessage = useCallback(
		async ({
			chatId,
			text,
			pendingFiles,
			location,
			replyToId,
			threadId: inThreadId,
		}: SendMessageParams) => {
			if (user === null) return;

			const msgId = genId();
			const now = new Date().toISOString();

			const encrypted = await encryptForChat(chatId, text);
			if (encrypted === null) return;

			const blobIds = await enqueuePendingBlobs(pendingFiles ?? []);
			const fileInfos: FileInfo[] = (pendingFiles ?? []).map(buildStoredFile);

			const stored: Message = {
				id: msgId,
				chatId,
				fromId: user.id,
				fromNick: user.nick,
				text: encrypted.text,
				encrypted: true,
				encryptedPayload: encrypted.encryptedPayload,
				createdAt: now,
				editedAt: undefined,
				replyTo: undefined,
				files: fileInfos.length > 0 ? fileInfos : undefined,
				location: location,
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
				text: encrypted.text,
				encrypted: true,
				encryptedPayload: encrypted.encryptedPayload,
				replyToId,
				pendingFileClientIds: blobIds,
				location,
				createdAt: now,
				attempts: 0,
				threadId: inThreadId,
			});

			scheduleSync();
		},
		[user, enqueuePendingBlobs, encryptForChat],
	);

	const editMessage = useCallback(
		async ({
			chatId,
			messageId,
			text,
			pendingFiles,
			location,
			clearLocation,
			filesToRemove,
			threadId: inThreadId,
		}: EditMessageParams) => {
			const current = inThreadId
				? await threadMessagesRepo.getById(inThreadId, messageId)
				: await messagesRepo.getById(chatId, messageId);
			if (current === undefined) return;

			const blobIds = await enqueuePendingBlobs(pendingFiles ?? []);
			const newFileInfos: FileInfo[] = (pendingFiles ?? []).map(
				buildStoredFile,
			);

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

			const encrypted = await encryptForChat(chatId, text);
			if (encrypted === null) return;

			const updated: Message = {
				...base,
				text: encrypted.text,
				encrypted: true,
				encryptedPayload: encrypted.encryptedPayload,
				files: mergedFiles,
				location: nextLocation,
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
				text: encrypted.text,
				encrypted: true,
				encryptedPayload: encrypted.encryptedPayload,
				pendingFileClientIds: blobIds,
				keptFileIds,
				filesToRemove: filesToRemove ?? [],
				location: nextLocation,
				clearLocation: clearLocation === true,
				clientEditedAt: now,
				createdAt: now,
				attempts: 0,
				threadId: inThreadId,
			});

			scheduleSync();
		},
		[enqueuePendingBlobs, encryptForChat],
	);

	const deleteMessage = useCallback(
		async (chatId: string, messageId: string, threadId?: string) => {
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
		},
		[],
	);

	const retryMessage = useCallback(
		async (chatId: string, messageId: string, threadId?: string) => {
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
		},
		[],
	);

	const cancelSendMessage = useCallback(
		async (chatId: string, messageId: string, threadId?: string) => {
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
		},
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
