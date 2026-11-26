import { useCallback, useRef } from "react";
import { createChat } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import type { Location, PendingFile } from "../types/api.ts";
import type { EditingMessage, ReplyTarget } from "../types/chat.ts";

interface ChatSubmitDeps {
	token: string | undefined;
	user: { id: string } | null;
	inputText: string;
	pendingFiles: PendingFile[];
	pendingLocation: Location | null;
	editingMessage: EditingMessage | null;
	pendingChatWith: string | null;
	pendingChatIsBot?: boolean;
	activeChatId: string | null;
	activeThreadId: string | null;
	replyToMessage: ReplyTarget | null;
	sendMessage: (opts: {
		chatId: string;
		text: string;
		pendingFiles?: PendingFile[];
		location?: Location | undefined;
		replyToId?: string;
		threadId?: string;
	}) => Promise<boolean | undefined>;
	editMessage: (opts: {
		chatId: string;
		messageId: string;
		text: string;
		pendingFiles?: PendingFile[];
		filesToRemove?: string[];
		location?: Location | null;
		clearLocation?: boolean;
		threadId?: string;
	}) => Promise<boolean | undefined>;
	selectChat: (id: string) => void;
	closeThread: () => void;
	clearAllPendingFiles: (keepObjectUrls?: boolean) => void;
	clearEditing: () => void;
	clearPendingChat: () => void;
	clearReply: () => void;
	clearPendingLocation: () => void;
	setInputText: (text: string) => void;
}

/**
 * Dedicated submit handler for the chat page, factored out of useChatPage so
 * that hook stays under the size budget. Collects the message-editing,
 * new-private-chat and active-chat send paths into one callback.
 */
export function useChatSubmit(
	deps: ChatSubmitDeps,
): (e: React.FormEvent<HTMLFormElement>) => Promise<void> {
	const {
		token,
		user,
		inputText,
		pendingFiles,
		pendingLocation,
		editingMessage,
		pendingChatWith,
		pendingChatIsBot,
		activeChatId,
		activeThreadId,
		replyToMessage,
		sendMessage,
		editMessage,
		selectChat,
		closeThread,
		clearAllPendingFiles,
		clearEditing,
		clearPendingChat,
		clearReply,
		clearPendingLocation,
		setInputText,
	} = deps;

	// A second submit before the first one clears the composer would reuse the
	// same pending files: two rows would reference one preview URL and the
	// second outbox operation would find its staged blob already consumed.
	const sendingRef = useRef(false);

	return useCallback(
		async (e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (!token || !user) return;
			if (sendingRef.current) return;
			sendingRef.current = true;
			try {
				await sendFromComposer({
					token,
					user,
					inputText,
					pendingFiles,
					pendingLocation,
					editingMessage,
					pendingChatWith,
					pendingChatIsBot,
					activeChatId,
					activeThreadId,
					replyToMessage,
					sendMessage,
					editMessage,
					selectChat,
					closeThread,
					clearAllPendingFiles,
					clearEditing,
					clearPendingChat,
					clearReply,
					clearPendingLocation,
					setInputText,
				});
			} finally {
				sendingRef.current = false;
			}
		},
		[
			token,
			user,
			inputText,
			pendingFiles,
			pendingLocation,
			editingMessage,
			pendingChatWith,
			pendingChatIsBot,
			activeChatId,
			activeThreadId,
			replyToMessage,
			sendMessage,
			editMessage,
			selectChat,
			closeThread,
			clearAllPendingFiles,
			clearEditing,
			clearPendingChat,
			clearReply,
			clearPendingLocation,
			setInputText,
		],
	);
}

async function sendFromComposer(
	ctx: ChatSubmitDeps & { token: string; user: { id: string } },
): Promise<void> {
	const {
		token,
		inputText,
		pendingFiles,
		pendingLocation,
		editingMessage,
		pendingChatWith,
		pendingChatIsBot,
		activeChatId,
		activeThreadId,
		replyToMessage,
		sendMessage,
		editMessage,
		selectChat,
		closeThread,
		clearAllPendingFiles,
		clearEditing,
		clearPendingChat,
		clearReply,
		clearPendingLocation,
		setInputText,
	} = ctx;

	const text = inputText.trim();
	const hasExistingEditContent =
		editingMessage !== null &&
		((editingMessage.files?.length ?? 0) > 0 ||
			editingMessage.location !== null);
	if (
		!text &&
		pendingFiles.length === 0 &&
		!pendingLocation &&
		!hasExistingEditContent
	) {
		return;
	}

	if (editingMessage !== null) {
		const nextLocation =
			editingMessage.location === undefined
				? undefined
				: editingMessage.location;

		try {
			const ok = await editMessage({
				chatId: editingMessage.chatId,
				messageId: editingMessage.messageId,
				text,
				pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
				filesToRemove: editingMessage.filesToRemove,
				location: nextLocation,
				clearLocation: nextLocation === null,
				threadId: editingMessage.threadId,
			});
			if (ok === false) return;
		} catch {
			return;
		}
		clearEditing();
		setInputText("");
		clearAllPendingFiles(true);
		clearReply();
		clearPendingLocation();
	} else if (pendingChatWith !== null) {
		try {
			const { chat } = await createChat(token, {
				type: "private",
				withUserId: pendingChatWith,
				withUserIsBot: pendingChatIsBot,
			});
			await chatsRepo.upsert(chat);
			selectChat(chat.id);
			closeThread();
			// Drop the pending state now that the chat exists and is
			// selected: if the first send fails, the retry must go
			// through the active-chat path instead of creating yet
			// another private chat.
			clearPendingChat();
			const ok = await sendMessage({
				chatId: chat.id,
				text,
				pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
				location: pendingLocation ?? undefined,
			});
			if (ok === false) return;
		} catch {
			return;
		}
		setInputText("");
		clearAllPendingFiles(true);
		clearReply();
		clearPendingLocation();
	} else if (activeThreadId !== null && activeChatId === null) {
		return;
	} else if (activeChatId !== null) {
		try {
			const ok = await sendMessage({
				chatId: activeChatId,
				text,
				pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
				location: pendingLocation ?? undefined,
				replyToId: replyToMessage?.messageId,
				threadId: activeThreadId ?? undefined,
			});
			if (ok === false) return;
		} catch {
			return;
		}
		setInputText("");
		clearAllPendingFiles(true);
		clearReply();
		clearPendingLocation();
	}
}
