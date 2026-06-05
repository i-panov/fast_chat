import { useCallback, useRef } from "react";
import type { Location, PendingFile } from "../api.ts";
import {
	deleteMessage,
	editMessage,
	editThreadMessage,
	sendMessage,
	sendThreadMessage,
	uploadFile,
} from "../api.ts";
import i18n from "../i18n.ts";
import { emitNotification } from "../utils/notify.ts";

interface UseMessageSenderParams {
	token: string;
	userId: string;
	userNick: string;
}

interface SendMessageParams {
	chatId: string;
	text: string;
	msgId: string;
	replyToId?: string;
	fileIDs?: string[];
	location?: Location;
	isThread?: boolean;
	threadId?: string;
}

interface EditMessageParams {
	chatId: string;
	messageId: string;
	text: string;
	fileIDs?: string[];
	location?: Location | null;
	clearLocation?: boolean;
	isThread?: boolean;
	threadId?: string;
}

interface UseMessageSenderReturn {
	sendMessage: (params: SendMessageParams) => Promise<void>;
	editMessage: (params: EditMessageParams) => Promise<void>;
	deleteMessage: (chatId: string, messageId: string) => Promise<void>;
	retryMessage: (
		chatId: string,
		messageId: string,
		text: string,
		isThread?: boolean,
		threadId?: string,
	) => Promise<void>;
	uploadFiles: (files: PendingFile[]) => Promise<string[]>;
}

export function useMessageSender({
	token,
	userId: _userId,
	userNick: _userNick,
}: UseMessageSenderParams): UseMessageSenderReturn {
	const sendingRef = useRef(false);

	const uploadFiles = useCallback(
		async (files: PendingFile[]): Promise<string[]> => {
			const fileIDs: string[] = [];
			for (const pf of files) {
				const { file: uploaded } = await uploadFile(token, pf.file);
				fileIDs.push(uploaded.id);
				URL.revokeObjectURL(pf.blobUrl);
			}
			return fileIDs;
		},
		[token],
	);

	const handleSend = useCallback(
		async ({
			chatId,
			text,
			msgId,
			replyToId,
			fileIDs = [],
			location,
			isThread = false,
			threadId,
		}: SendMessageParams) => {
			if (sendingRef.current) return;
			sendingRef.current = true;

			try {
				if (isThread && threadId) {
					await sendThreadMessage(
						token,
						chatId,
						threadId,
						text,
						msgId,
						replyToId,
						fileIDs,
						location,
					);
				} else {
					await sendMessage(
						token,
						chatId,
						text,
						msgId,
						replyToId,
						fileIDs,
						location,
					);
				}
			} catch {
				emitNotification(i18n.t("error.send"));
			} finally {
				sendingRef.current = false;
			}
		},
		[token],
	);

	const handleEdit = useCallback(
		async ({
			chatId,
			messageId,
			text,
			fileIDs,
			location,
			clearLocation,
			isThread = false,
			threadId,
		}: EditMessageParams) => {
			try {
				if (isThread && threadId) {
					await editThreadMessage(
						token,
						chatId,
						threadId,
						messageId,
						text,
						fileIDs,
						{ location, clearLocation },
					);
				} else {
					await editMessage(token, chatId, messageId, text, fileIDs, {
						location,
						clearLocation,
					});
				}
			} catch {
				emitNotification(i18n.t("error.send"));
			}
		},
		[token],
	);

	const handleDelete = useCallback(
		async (chatId: string, messageId: string) => {
			try {
				await deleteMessage(token, chatId, messageId);
			} catch {
				emitNotification(i18n.t("error.delete"));
			}
		},
		[token],
	);

	const handleRetry = useCallback(
		async (
			chatId: string,
			messageId: string,
			text: string,
			isThread = false,
			threadId?: string,
		) => {
			const msgId = messageId;
			try {
				if (isThread && threadId) {
					await sendThreadMessage(token, chatId, threadId, text, msgId);
				} else {
					await sendMessage(token, chatId, text, msgId);
				}
			} catch {
				emitNotification(i18n.t("error.send"));
			}
		},
		[token],
	);

	return {
		sendMessage: handleSend,
		editMessage: handleEdit,
		deleteMessage: handleDelete,
		retryMessage: handleRetry,
		uploadFiles,
	};
}
