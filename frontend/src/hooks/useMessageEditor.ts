import { useCallback, useEffect, useRef, useState } from "react";
import type { FileInfo, Message } from "../types/api.ts";
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
	activeThreadMessages: Message[] = [],
): UseMessageEditorReturn {
	const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(
		null,
	);
	const [replyToMessage, setReplyToMessage] = useState<ReplyTarget | null>(
		null,
	);
	const activeMessagesRef = useRef(activeMessages);
	useEffect(() => {
		activeMessagesRef.current = activeMessages;
	}, [activeMessages]);
	// Thread rows live in a different store and a different list: reply and
	// edit must resolve them too, otherwise the menu items silently no-op
	// inside ThreadView.
	const activeThreadMessagesRef = useRef(activeThreadMessages);
	useEffect(() => {
		activeThreadMessagesRef.current = activeThreadMessages;
	}, [activeThreadMessages]);

	const findMessage = useCallback(
		(messageId: string) =>
			activeMessagesRef.current.find((m) => m.id === messageId) ??
			activeThreadMessagesRef.current.find((m) => m.id === messageId),
		[],
	);

	const handleStartEdit = useCallback(
		(
			chatId: string,
			messageId: string,
			text: string,
			files?: FileInfo[],
			threadId?: string,
		) => {
			const msg = findMessage(messageId);
			setEditingMessage({
				chatId,
				messageId,
				text,
				files,
				filesToRemove: [],
				threadId,
				location: msg?.location ?? null,
			});
		},
		[findMessage],
	);

	const handleRemoveExistingFile = useCallback((fileId: string) => {
		setEditingMessage((prev) => {
			if (!prev) return null;
			const removed = prev.filesToRemove ?? [];
			return {
				...prev,
				files: prev.files?.filter((f) => f.id !== fileId),
				filesToRemove: removed.includes(fileId)
					? removed
					: [...removed, fileId],
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
			const msg = findMessage(messageId);
			if (!msg) return;
			setReplyToMessage({
				chatId,
				messageId,
				fromNick: msg.fromNick,
				text: msg.text,
				files: msg.files,
			});
		},
		[findMessage],
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
