import { useCallback, useEffect, useState } from "react";
import type {
	Chat,
	FileInfo,
	Location,
	Message,
	Thread,
	TypingPayload,
	User,
} from "../api.ts";
import { createChat, refreshToken, sendTyping } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import {
	retryFailedOps,
	scheduleSync,
	setTokenProvider,
} from "../sync/syncEngine.ts";
import type { EditingMessage, ReplyTarget } from "../types/chat.ts";
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

export interface ChatPageState {
	activeAccount: { token: string; user: { id: string; nick: string } } | null;
	user: { id: string; nick: string } | null;
	logout: () => void;

	switcherOpen: boolean;
	setSwitcherOpen: (open: boolean) => void;

	chats: Chat[];
	activeChatId: string | null;
	activeChat: Chat | undefined;
	selectChat: (chatId: string | null) => void;

	activeMessages: Array<Message & { status: "sent" | "queued" | "failed" }>;
	hasMore: boolean;
	isLoadingMore: boolean;
	loadMoreMessages: (chatId: string | null) => Promise<void>;

	threads: Record<string, Thread>;
	messageToThread: Record<string, string>;
	activeThreadId: string | null;
	activeThread: Thread | null;
	activeThreadMessages: Message[];
	threadHasMore: boolean;
	threadIsLoadingMore: boolean;
	handleOpenThread: (threadId: string) => void;
	handleCloseThread: () => void;
	loadMoreThreadMessages: () => Promise<void>;
	handleCreateThread: (chatId: string, messageId: string) => Promise<void>;

	typingUsers: Record<string, TypingPayload[]>;
	handleTyping: (chatId: string, active: boolean) => void;

	pendingFiles: PendingFileLite[];
	handleAttachFiles: (files: File[]) => void;
	handleRemoveFile: (id: string) => void;

	config: { messageEditTTL: number; messageDeleteTTL: number } | null;

	searchQuery: string;
	searchResults: User[];
	showSearchResults: boolean;
	handleSearchChange: (value: string) => void;

	pendingChatWith: string | null;
	pendingChatNick: string | null;
	selectPendingChat: (withUserId: string, withUserNick: string) => void;

	inputText: string;
	setInputText: (v: string) => void;

	handleSend: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
	handleSendThreadMessage: (
		e: React.FormEvent<HTMLFormElement>,
	) => Promise<void>;

	handleDeleteMessage: (chatId: string, messageId: string) => void;

	editingMessage: EditingMessage | null;
	handleStartEdit: (
		chatId: string,
		messageId: string,
		text: string,
		files?: FileInfo[],
		threadId?: string,
	) => void;
	handleCancelEdit: () => void;
	handleRemoveExistingFile: (fileId: string) => void;
	handleRemoveExistingLocation: () => void;

	replyToMessage: ReplyTarget | null;
	handleReply: (chatId: string, messageId: string) => void;
	cancelReply: () => void;

	handleRetryMessage: (chatId: string, messageId: string) => Promise<void>;
	handleCancelSendMessage: (
		chatId: string,
		messageId: string,
		threadId?: string,
	) => Promise<void>;
	handleDeleteThreadMessage: (threadId: string, messageId: string) => void;
	handleRetryThreadMessage: (
		threadId: string,
		messageId: string,
	) => Promise<void>;

	pendingLocation: Location | null;
	locationPickerOpen: boolean;
	setLocationPickerOpen: (v: boolean) => void;
	openLocationPicker: () => void;
	handleLocationConfirm: (loc: Location) => void;
	handleRemovePendingLocation: () => void;

	createGroupOpen: boolean;
	setCreateGroupOpen: (v: boolean) => void;
	handleCreateGroup: (name: string, memberIds: string[]) => Promise<void>;
	groupSettingsChatId: string | null;
	groupSettings: Chat | null;
	openGroupSettings: (chatId: string) => Promise<void>;
	closeGroupSettings: () => void;
	handleRenameGroup: (name: string) => Promise<void>;
	handleAddGroupMember: (userId: string) => Promise<void>;
	handleRemoveGroupMember: (userId: string) => Promise<void>;
	handleDeleteGroup: () => Promise<void>;
	handleUploadGroupAvatar: (file: File) => Promise<void>;

	isOnline: boolean;
	syncState: "idle" | "syncing" | "error";
}

interface PendingFileLite {
	id: string;
	file: File;
	blobUrl: string;
	originalName: string;
	size: number;
	mimeType: string;
	fileType: "photo" | "video" | "audio" | "file";
}

export type { EditingMessage, ReplyTarget } from "../types/chat.ts";

export { useChatList } from "./useChatList";
export { useGroupSettings } from "./useGroupSettings";
export { useLocationPicker } from "./useLocationPicker";
export { useMessageEditor } from "./useMessageEditor";
export { useMessageSearch } from "./useMessageSearch";
export { useMessageSender } from "./useMessageSender";
export { useMessages } from "./useMessages";
export { useNetworkStatus } from "./useNetworkStatus";
export { usePendingFiles } from "./usePendingFiles";
export { useSseEvents } from "./useSseEvents";
export { useSyncStatus } from "./useSyncStatus";
export { useThreads } from "./useThreads";
export { useTyping } from "./useTyping";

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
	const { typingUsers, addTypingUser, clearTyping } = useTyping({ token });
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
		handleRemovePendingLocation,
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

	const handleTyping = useCallback(
		(chatId: string, active: boolean) => {
			if (!token) return;
			sendTyping(token, chatId, active).catch(() => {});
		},
		[token],
	);

	const handleRemoveFile = useCallback(
		(id: string) => {
			removeFile(id);
		},
		[removeFile],
	);

	const handleSend = useCallback(
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
				await sendMessage({
					chatId: chat.id,
					text,
					pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
					location: pendingLocation ?? undefined,
				});
				clearPendingChat();
			} else if (activeChatId !== null) {
				await sendMessage({
					chatId: activeChatId,
					text,
					pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
					location: pendingLocation ?? undefined,
					replyToId: replyToMessage?.messageId,
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
			replyToMessage,
			sendMessage,
			editMessage,
			selectChat,
			clearAllPendingFiles,
			clearEditing,
			clearPendingChat,
			clearReply,
			clearPendingLocation,
		],
	);

	const handleSendThreadMessage = useCallback(
		async (e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (!token || !activeThreadId || !activeChatId) return;

			const text = inputText.trim();
			if (!text && pendingFiles.length === 0 && !pendingLocation) return;

			if (editingMessage?.threadId) {
				await editMessage({
					chatId: editingMessage.chatId,
					messageId: editingMessage.messageId,
					text,
					pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
					location: editingMessage.location,
					clearLocation: editingMessage.location === null,
					threadId: editingMessage.threadId,
				});
				clearEditing();
			} else {
				await sendMessage({
					chatId: activeChatId,
					text,
					pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
					location: pendingLocation ?? undefined,
					replyToId: replyToMessage?.messageId,
					threadId: activeThreadId,
				});
			}

			setInputText("");
			clearAllPendingFiles();
			clearReply();
			clearPendingLocation();
		},
		[
			token,
			activeThreadId,
			activeChatId,
			inputText,
			pendingFiles,
			pendingLocation,
			editingMessage,
			replyToMessage,
			sendMessage,
			editMessage,
			clearAllPendingFiles,
			clearEditing,
			clearReply,
			clearPendingLocation,
		],
	);

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
		pendingFiles: pendingFiles as PendingFileLite[],
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
		handleRemovePendingLocation,
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
