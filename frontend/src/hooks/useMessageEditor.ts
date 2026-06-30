import { useCallback, useState } from "react";
import type { FileInfo, Message } from "../api.ts";
import type { EditingMessage, ReplyTarget } from "../types/chat.ts";

export interface UseMessageEditorReturn {
	editingMessage: EditingMessage | null;
	setEditingMessage: React.Dispatch<
		React.SetStateAction<EditingMessage | null>
	>;
	replyToMessage: ReplyTarget | null;
	setReplyToMessage: React.Dispatch<React.SetStateAction<ReplyTarget | null>>;
	handleStartEdit: (
		chatId: string,
		messageId: string,
		text: string,
		files?: FileInfo[],
		threadId?: string,
	) => void;
	handleRemoveExistingFile: (fileId: string) => void;
	handleRemoveExistingLocation: () => void;
	handleReply: (chatId: string, messageId: string) => void;
	cancelReply: () => void;
	clearEditing: () => void;
	clearReply: () => void;
}

export function useMessageEditor(
	activeMessages: Message[],
): UseMessageEditorReturn {
	const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(
		null,
	);
	const [replyToMessage, setReplyToMessage] = useState<ReplyTarget | null>(
		null,
	);

	const handleStartEdit = useCallback(
		(
			chatId: string,
			messageId: string,
			text: string,
			files?: FileInfo[],
			threadId?: string,
		) => {
			const msg = activeMessages.find((m) => m.id === messageId);
			setEditingMessage({
				chatId,
				messageId,
				text,
				files,
				threadId,
				location: msg?.location ?? null,
			});
		},
		[activeMessages],
	);

	const handleRemoveExistingFile = useCallback((fileId: string) => {
		setEditingMessage((prev) => {
			if (!prev) return null;
			return {
				...prev,
				files: prev.files?.filter((f) => f.id !== fileId),
			};
		});
	}, []);

	const handleRemoveExistingLocation = useCallback(() => {
		setEditingMessage((prev) => {
			if (!prev) return null;
			return { ...prev, location: null };
		});
	}, []);

	const handleReply = useCallback(
		(chatId: string, messageId: string) => {
			const msg = activeMessages.find((m) => m.id === messageId);
			if (!msg) return;
			setReplyToMessage({
				chatId,
				messageId,
				fromNick: msg.fromNick,
				text: msg.text,
				files: msg.files,
			});
		},
		[activeMessages],
	);

	const cancelReply = useCallback(() => {
		setReplyToMessage(null);
	}, []);

	const clearEditing = useCallback(() => {
		setEditingMessage(null);
	}, []);

	const clearReply = useCallback(() => {
		setReplyToMessage(null);
	}, []);

	return {
		editingMessage,
		setEditingMessage,
		replyToMessage,
		setReplyToMessage,
		handleStartEdit,
		handleRemoveExistingFile,
		handleRemoveExistingLocation,
		handleReply,
		cancelReply,
		clearEditing,
		clearReply,
	};
}
