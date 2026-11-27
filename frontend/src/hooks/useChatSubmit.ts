import { useCallback, useEffect, useRef } from "react";
import { createChat } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import i18n from "../i18n.ts";
import type { Location, PendingFile } from "../types/api.ts";
import type { EditingMessage, ReplyTarget } from "../types/chat.ts";
import { emitNotification } from "../utils/notify.ts";

const SEND_FAILED_KEY = "error.send";

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
	removePendingFiles: (fileIds: string[], keepObjectUrls?: boolean) => void;
	clearEditing: () => void;
	clearPendingChat: () => void;
	clearReply: () => void;
	clearPendingLocation: () => void;
	setInputText: (text: string) => void;
}

// ComposerSnapshot is what the submit actually took: text, the exact
// attachments and the reply/location it consumed. Cleanup after the await
// must not touch anything the user added while the send was in flight.
interface ComposerSnapshot {
	text: string;
	fileIds: string[];
	location: Location | null;
	replyId: string | null;
}

function snapshotComposer(deps: {
	inputText: string;
	pendingFiles: PendingFile[];
	pendingLocation: Location | null;
	replyToMessage: ReplyTarget | null;
}): ComposerSnapshot {
	return {
		text: deps.inputText,
		fileIds: deps.pendingFiles.map((f) => f.id),
		location: deps.pendingLocation,
		replyId: deps.replyToMessage?.messageId ?? null,
	};
}

/**
 * Dedicated submit handler for the chat page, factored out of useChatPage so
 * that hook stays under the size budget. Collects the message-editing,
 * new-private-chat and active-chat send paths into one callback.
 */
export function useChatSubmit(
	deps: ChatSubmitDeps,
): (e: React.FormEvent<HTMLFormElement>) => Promise<void> {
	// The composer values as of the latest render: the send awaits encryption
	// and network work, and cleanup may only clear what the submit consumed.
	const latestRef = useRef(deps);
	useEffect(() => {
		latestRef.current = deps;
	});

	// A second submit before the first one clears the composer would reuse the
	// same pending files: two rows would reference one preview URL and the
	// second outbox operation would find its staged blob already consumed.
	const sendingRef = useRef(false);

	return useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const current = latestRef.current;
		if (!current.token || !current.user) return;
		if (sendingRef.current) return;
		sendingRef.current = true;
		try {
			await sendFromComposer(current, () => latestRef.current);
		} finally {
			sendingRef.current = false;
		}
	}, []);
}

async function sendFromComposer(
	ctx: ChatSubmitDeps,
	getLatest: () => ChatSubmitDeps,
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
		removePendingFiles,
		clearEditing,
		clearPendingChat,
		clearReply,
		clearPendingLocation,
		setInputText,
	} = ctx;

	const text = inputText.trim();
	if (token === undefined) return;
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

	const snapshot = snapshotComposer({
		inputText,
		pendingFiles,
		pendingLocation,
		replyToMessage,
	});

	// Clears only the consumed values. Text and attachments that appeared
	// while sendMessage was awaiting stay in the composer.
	const clearSent = () => {
		const latest = getLatest();
		if (latest.inputText === snapshot.text) setInputText("");
		if (latest.pendingLocation === snapshot.location) clearPendingLocation();
		if ((latest.replyToMessage?.messageId ?? null) === snapshot.replyId) {
			clearReply();
		}
		const stillPending = new Set(latest.pendingFiles.map((f) => f.id));
		const sentIds = snapshot.fileIds.filter((id) => stillPending.has(id));
		if (sentIds.length > 0) {
			// Ownership of the preview URL moved to the optimistic message row.
			removePendingFiles(sentIds, true);
		}
	};

	if (editingMessage !== null) {
		// A location picked while editing wins over the one stored on the
		// message: the picker stays available in edit mode, so dropping the
		// pick would silently discard it.
		const nextLocation =
			pendingLocation ??
			(editingMessage.location === undefined
				? undefined
				: editingMessage.location);

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
			emitNotification(i18n.t(SEND_FAILED_KEY));
			return;
		}
		clearEditing();
		clearSent();
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
			emitNotification(i18n.t(SEND_FAILED_KEY));
			return;
		}
		clearSent();
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
			emitNotification(i18n.t(SEND_FAILED_KEY));
			return;
		}
		clearSent();
	}
}
