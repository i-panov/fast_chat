import { useCallback, useEffect, useState } from "react";
import { createChat, refreshToken } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { ensureAccountKeys, RecoveryRequiredError } from "../e2ee/keys.ts";
import {
	retryFailedOps,
	scheduleSync,
	setTokenProvider,
} from "../sync/syncEngine.ts";
import type { ChatPageState } from "../types/chat.ts";
import { useAuth } from "../useAuth";
import { useChatList } from "./useChatList";
import { useGroupSettings } from "./useGroupSettings";
import { useLocationPicker } from "./useLocationPicker";
import { useMessageEditor } from "./useMessageEditor";
import { useMessageSearch } from "./useMessageSearch";
import { useMessageSender } from "./useMessageSender";
import { useMessages } from "./useMessages";
import { useNetworkStatus, useOnlineNotifications } from "./useNetworkStatus";
import { usePendingFiles } from "./usePendingFiles";
import { useServerConfig } from "./useServerConfig";
import { useSseEvents } from "./useSseEvents";
import { useSyncStatus } from "./useSyncStatus";
import { useThreads } from "./useThreads";
import { useTyping } from "./useTyping";

export function useChatPage(): ChatPageState {
	const { activeAccount, logout, updateAccountToken } = useAuth();
	const user = activeAccount?.user ?? null;
	const token = activeAccount?.token;
	const { config } = useServerConfig(token);

	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [inputText, setInputText] = useState("");

	const { chats, activeChatId, activeChat, selectChat } = useChatList({
		token,
	});
	const {
		messages: activeMessages,
		hasMore,
		isLoadingMore,
		loadMore,
	} = useMessages({
		token,
		chatId: activeChatId,
	});
	const {
		threads,
		messageToThread,
		activeThreadId,
		activeThread,
		activeThreadMessages,
		threadHasMore,
		threadIsLoadingMore,
		createThread,
		openThread,
		closeThread,
		loadMoreThreadMessages,
		knownThreadIdsRef,
	} = useThreads({
		token,
		chatId: activeChatId,
	});
	const { typingUsers, handleTyping, addTypingUser, clearTyping } = useTyping({
		token,
	});
	const {
		pendingFiles,
		handleAttachFiles,
		handleRemoveFile: removeFile,
		clearAllPendingFiles,
	} = usePendingFiles();
	const {
		sendMessage,
		editMessage,
		deleteMessage,
		retryMessage,
		cancelSendMessage,
	} = useMessageSender({
		token: token ?? "",
	});

	const {
		pendingLocation,
		locationPickerOpen,
		setLocationPickerOpen,
		openLocationPicker,
		handleLocationConfirm,
		clearPendingLocation,
	} = useLocationPicker();

	const {
		searchQuery,
		searchResults,
		showSearchResults,
		handleSearchChange,
		pendingChatWith,
		pendingChatNick,
		selectPendingChat,
		clearPendingChat,
	} = useMessageSearch(token);

	const {
		editingMessage,
		replyToMessage,
		handleStartEdit,
		handleRemoveExistingFile,
		handleRemoveExistingLocation,
		handleReply,
		cancelReply,
		clearEditing,
		clearReply,
	} = useMessageEditor(activeMessages);

	const {
		createGroupOpen,
		setCreateGroupOpen,
		handleCreateGroup,
		groupSettingsChatId,
		groupSettings,
		openGroupSettings,
		closeGroupSettings,
		handleRenameGroup,
		handleAddGroupMember,
		handleRemoveGroupMember,
		handleDeleteGroup,
		handleUploadGroupAvatar,
	} = useGroupSettings({
		token,
		userId: user?.id,
		activeChatId,
		selectChat,
	});

	const isOnline = useNetworkStatus();
	const syncState = useSyncStatus();

	useEffect(() => {
		setTokenProvider(() => token ?? null);
	}, [token]);

	// E2E: make sure the account has a key pair and its public key is
	// uploaded before any message is sent.
	useEffect(() => {
		if (token === undefined) return;
		void ensureAccountKeys(token).catch((err) => {
			// Recovery is surfaced by the UI via the recovery-needed event;
			// not a fatal error worth logging as a failure.
			if (err instanceof RecoveryRequiredError) return;
			console.error("E2E key generation failed:", err);
		});
	}, [token]);

	const handleBackOnline = useCallback(() => {
		void retryFailedOps().then(() => scheduleSync());
	}, []);
	useOnlineNotifications(handleBackOnline);

	useSseEvents({
		token: token ?? "",
		knownThreadIdsRef,
		addTypingUser,
		clearTyping,
		onTokenExpiring: async (currentToken: string) => {
			try {
				const { token: newToken, expiresAt } = await refreshToken(currentToken);
				updateAccountToken(currentToken, newToken, expiresAt);
			} catch {
				logout();
			}
		},
		onTokenExpired: () => {
			logout();
		},
	});

	const handleRemoveFile = useCallback(
		(id: string) => {
			removeFile(id);
		},
		[removeFile],
	);

	const handleSubmit = useCallback(
		async (e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (!token || !user) return;

			const text = inputText.trim();
			if (!text && pendingFiles.length === 0 && !pendingLocation) return;

			if (editingMessage !== null) {
				const nextLocation =
					editingMessage.location === undefined
						? undefined
						: editingMessage.location;

				await editMessage({
					chatId: editingMessage.chatId,
					messageId: editingMessage.messageId,
					text,
					pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
					location: nextLocation,
					clearLocation: nextLocation === null,
					threadId: editingMessage.threadId,
				});
				clearEditing();
			} else if (pendingChatWith !== null) {
				const { chat } = await createChat(token, {
					type: "private",
					withUserId: pendingChatWith,
				});
				await chatsRepo.upsert(chat);
				selectChat(chat.id);
				// Opening a new chat should not leave a stale thread active;
				// otherwise the reply would be sent to the previous thread.
				closeThread();
				await sendMessage({
					chatId: chat.id,
					text,
					pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
					location: pendingLocation ?? undefined,
				});
				clearPendingChat();
			} else if (activeThreadId !== null && activeChatId === null) {
				return;
			} else if (activeChatId !== null) {
				await sendMessage({
					chatId: activeChatId,
					text,
					pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
					location: pendingLocation ?? undefined,
					replyToId: replyToMessage?.messageId,
					threadId: activeThreadId ?? undefined,
				});
			}

			setInputText("");
			clearAllPendingFiles();
			clearReply();
			clearPendingLocation();
		},
		[
			token,
			user,
			inputText,
			pendingFiles,
			pendingLocation,
			editingMessage,
			pendingChatWith,
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
		],
	);

	const handleSend = handleSubmit;
	const handleSendThreadMessage = handleSubmit;

	const handleCancelEdit = useCallback(() => {
		clearEditing();
		setInputText("");
		clearAllPendingFiles();
		clearPendingLocation();
		clearReply();
	}, [clearEditing, clearAllPendingFiles, clearPendingLocation, clearReply]);

	const handleDeleteThreadMessage = useCallback(
		(threadId: string, messageId: string) => {
			void deleteMessage(activeChatId ?? "", messageId, threadId);
		},
		[activeChatId, deleteMessage],
	);

	const handleRetryThreadMessage = useCallback(
		async (threadId: string, messageId: string) => {
			await retryMessage(activeChatId ?? "", messageId, threadId);
		},
		[activeChatId, retryMessage],
	);

	return {
		activeAccount: activeAccount ?? null,
		user,
		logout,
		switcherOpen,
		setSwitcherOpen,
		chats,
		activeChatId,
		activeChat,
		selectChat,
		activeMessages,
		hasMore,
		isLoadingMore,
		loadMoreMessages: loadMore,
		threads,
		messageToThread,
		activeThreadId,
		activeThread,
		activeThreadMessages,
		threadHasMore,
		threadIsLoadingMore,
		handleOpenThread: openThread,
		handleCloseThread: closeThread,
		loadMoreThreadMessages,
		handleCreateThread: createThread,
		typingUsers,
		handleTyping,
		pendingFiles,
		handleAttachFiles,
		handleRemoveFile,
		config,
		searchQuery,
		searchResults,
		showSearchResults,
		handleSearchChange,
		pendingChatWith,
		pendingChatNick,
		selectPendingChat,
		inputText,
		setInputText,
		handleSend,
		handleSendThreadMessage,
		handleDeleteMessage: deleteMessage,
		editingMessage,
		handleStartEdit,
		handleCancelEdit,
		handleRemoveExistingFile,
		handleRemoveExistingLocation,
		replyToMessage,
		handleReply,
		cancelReply,
		handleRetryMessage: retryMessage,
		handleCancelSendMessage: cancelSendMessage,
		handleDeleteThreadMessage,
		handleRetryThreadMessage,
		pendingLocation,
		locationPickerOpen,
		setLocationPickerOpen,
		openLocationPicker,
		handleLocationConfirm,
		clearPendingLocation,
		createGroupOpen,
		setCreateGroupOpen,
		handleCreateGroup,
		groupSettingsChatId,
		groupSettings,
		openGroupSettings,
		closeGroupSettings,
		handleRenameGroup,
		handleAddGroupMember,
		handleRemoveGroupMember,
		handleDeleteGroup,
		handleUploadGroupAvatar,
		isOnline,
		syncState,
	};
}
