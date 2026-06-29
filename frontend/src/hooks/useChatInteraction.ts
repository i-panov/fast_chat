import { useCallback, useEffect, useRef, useState } from "react";
import type {
	Chat,
	FileInfo,
	Location,
	Message,
	Thread,
	TypingPayload,
	User,
} from "../api.ts";
import {
	createChat,
	editThreadMessage,
	getConfig,
	refreshToken,
	sendThreadMessage,
	sendTyping,
	uploadFile,
} from "../api.ts";
import type { EditingMessage, ReplyTarget } from "../context/ChatPageContext";
import { chatsRepo } from "../db/chatsRepo.ts";
import i18n from "../i18n.ts";
import {
	retryFailedOps,
	scheduleSync,
	setTokenProvider,
} from "../sync/syncEngine.ts";
import { useAuth } from "../useAuth";
import { emitNotification } from "../utils/notify.ts";
import { useChatList } from "./useChatList";
import { useGroupSettings } from "./useGroupSettings";
import { useLocationPicker } from "./useLocationPicker";
import { useMessageEditor } from "./useMessageEditor";
import { useMessageSearch } from "./useMessageSearch";
import { useMessageSender } from "./useMessageSender";
import { useMessages } from "./useMessages";
import { useNetworkStatus, useOnlineNotifications } from "./useNetworkStatus";
import { usePendingFiles } from "./usePendingFiles";
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

export type { EditingMessage, ReplyTarget } from "../context/ChatPageContext";
export {
	ChatPageProvider,
	useChatPageContext,
} from "../context/ChatPageContext";

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

	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [config, setConfig] = useState<ChatPageState["config"]>(null);
	const [inputText, setInputText] = useState("");

	const [threadsMap, setThreadsMap] = useState<Record<string, Thread>>({});
	const [messageToThreadMap, setMessageToThreadMap] = useState<
		Record<string, string>
	>({});
	const [threadMessagesMap, setThreadMessagesMap] = useState<
		Record<string, Message[]>
	>({});

	const configAbortRef = useRef<AbortController | null>(null);

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
	} = useThreads({
		token,
		chatId: activeChatId,
		threadsMap,
		setThreadsMap,
		messageToThreadMap,
		setMessageToThreadMap,
		threadMessagesMap,
		setThreadMessagesMap,
	});
	const { typingUsers, addTypingUser, clearTyping } = useTyping({ token });
	const {
		pendingFiles,
		handleAttachFiles,
		handleRemoveFile: removeFile,
		clearAllPendingFiles,
	} = usePendingFiles();
	const { sendMessage, editMessage, deleteMessage, retryMessage } =
		useMessageSender({
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

	useEffect(() => {
		if (!token) {
			setConfig(null);
			return;
		}
		configAbortRef.current?.abort();
		const ctrl = new AbortController();
		configAbortRef.current = ctrl;
		getConfig()
			.then((cfg) => {
				if (!ctrl.signal.aborted) setConfig(cfg);
			})
			.catch(() => {});
		return () => ctrl.abort();
	}, [token]);

	useSseEvents({
		token: token ?? "",
		setThreadsMap,
		setThreadMessagesMap,
		setMessageToThreadMap,
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

	const handleAttachFilesWrapped = useCallback(
		(files: File[]) => {
			handleAttachFiles(files);
		},
		[handleAttachFiles],
	);

	const handleRemoveFile = useCallback(
		(id: string) => {
			removeFile(id);
		},
		[removeFile],
	);

	const handleOpenThread = useCallback(
		(threadId: string) => {
			openThread(threadId);
		},
		[openThread],
	);

	const handleCloseThread = useCallback(() => {
		closeThread();
	}, [closeThread]);

	const handleCreateThread = useCallback(
		async (chatId: string, messageId: string) => {
			await createThread(chatId, messageId);
		},
		[createThread],
	);

	const loadMoreMessages = useCallback(
		async (_chatId: string | null) => {
			await loadMore();
		},
		[loadMore],
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
				const isThread = !!editingMessage.threadId;

				if (isThread && editingMessage.threadId !== undefined) {
					const fileIDs =
						pendingFiles.length > 0
							? pendingFiles.map((f) => f.id)
							: editingMessage.files?.map((f) => f.id);
					try {
						await editThreadMessage(
							token,
							editingMessage.chatId,
							editingMessage.threadId,
							editingMessage.messageId,
							text,
							fileIDs,
							{ location: nextLocation, clearLocation: nextLocation === null },
						);
					} catch {
						emitNotification(i18n.t("error.send"));
					}
				} else {
					await editMessage({
						chatId: editingMessage.chatId,
						messageId: editingMessage.messageId,
						text,
						pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
						location: nextLocation,
						clearLocation: nextLocation === null,
					});
				}
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

			const msgId = crypto.randomUUID();

			if (editingMessage?.threadId) {
				const nextLocation =
					editingMessage.location === undefined
						? undefined
						: editingMessage.location;
				const fileIDs =
					pendingFiles.length > 0
						? pendingFiles.map((f) => f.id)
						: editingMessage.files?.map((f) => f.id);
				try {
					await editThreadMessage(
						token,
						editingMessage.chatId,
						editingMessage.threadId,
						editingMessage.messageId,
						text,
						fileIDs,
						{ location: nextLocation, clearLocation: nextLocation === null },
					);
				} catch {
					emitNotification(i18n.t("error.send"));
				}
				clearEditing();
			} else {
				setThreadMessagesMap((prev) => ({
					...prev,
					[activeThreadId]: [
						...(prev[activeThreadId] ?? []),
						{
							id: msgId,
							chatId: activeChatId,
							fromId: user?.id ?? "",
							fromNick: user?.nick ?? "",
							text,
							createdAt: new Date().toISOString(),
							files:
								pendingFiles.length > 0
									? pendingFiles.map((pf) => ({
											id: pf.id,
											originalName: pf.originalName,
											size: pf.size,
											mimeType: pf.mimeType,
											fileType: pf.fileType,
											url: pf.blobUrl,
										}))
									: undefined,
							location: pendingLocation ?? undefined,
							status: "queued",
						},
					],
				}));
				try {
					const uploadedFileIds: string[] = [];
					for (const pf of pendingFiles) {
						const { file: uploaded } = await uploadFile(token, pf.file);
						uploadedFileIds.push(uploaded.id);
					}

					await sendThreadMessage(
						token,
						activeChatId,
						activeThreadId,
						text,
						msgId,
						replyToMessage?.messageId,
						uploadedFileIds.length > 0 ? uploadedFileIds : undefined,
						pendingLocation ?? undefined,
					);
					setThreadMessagesMap((prev) => {
						const list = prev[activeThreadId] ?? [];
						return {
							...prev,
							[activeThreadId]: list.map((m) =>
								m.id === msgId ? { ...m, status: "sent" as const } : m,
							),
						};
					});
				} catch {
					setThreadMessagesMap((prev) => {
						const list = prev[activeThreadId] ?? [];
						return {
							...prev,
							[activeThreadId]: list.map((m) =>
								m.id === msgId ? { ...m, status: "failed" as const } : m,
							),
						};
					});
					emitNotification(i18n.t("error.send"));
				}
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
			user?.id,
			user?.nick,
			inputText,
			pendingFiles,
			pendingLocation,
			editingMessage,
			replyToMessage,
			clearAllPendingFiles,
			clearEditing,
			clearReply,
			clearPendingLocation,
		],
	);

	const handleDeleteMessage = useCallback(
		(chatId: string, messageId: string) => {
			void deleteMessage(chatId, messageId);
		},
		[deleteMessage],
	);

	const handleCancelEdit = useCallback(() => {
		clearEditing();
		setInputText("");
		clearAllPendingFiles();
		clearPendingLocation();
		clearReply();
	}, [clearEditing, clearAllPendingFiles, clearPendingLocation, clearReply]);

	const handleRetryMessage = useCallback(
		async (chatId: string, messageId: string) => {
			await retryMessage(chatId, messageId);
		},
		[retryMessage],
	);

	const handleRetryThreadMessage = useCallback(
		async (threadId: string, messageId: string) => {
			if (!activeThread) return;
			const msg = activeThreadMessages.find((m) => m.id === messageId);
			if (!msg) return;
			setThreadMessagesMap((prev) => {
				const list = prev[threadId];
				if (list === undefined) return prev;
				return {
					...prev,
					[threadId]: list.map((m) =>
						m.id === messageId ? { ...m, status: "queued" as const } : m,
					),
				};
			});
			try {
				await sendThreadMessage(
					token ?? "",
					activeThread.chatId,
					threadId,
					msg.text,
					messageId,
				);
				setThreadMessagesMap((prev) => {
					const list = prev[threadId];
					if (list === undefined) return prev;
					return {
						...prev,
						[threadId]: list.map((m) =>
							m.id === messageId ? { ...m, status: "sent" as const } : m,
						),
					};
				});
			} catch {
				setThreadMessagesMap((prev) => {
					const list = prev[threadId];
					if (list === undefined) return prev;
					return {
						...prev,
						[threadId]: list.map((m) =>
							m.id === messageId ? { ...m, status: "failed" as const } : m,
						),
					};
				});
				emitNotification(i18n.t("error.send"));
			}
		},
		[activeThread, activeThreadMessages, token],
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
		loadMoreMessages,
		threads,
		messageToThread,
		activeThreadId,
		activeThread,
		activeThreadMessages,
		threadHasMore,
		threadIsLoadingMore,
		handleOpenThread,
		handleCloseThread,
		loadMoreThreadMessages,
		handleCreateThread,
		typingUsers,
		handleTyping,
		pendingFiles: pendingFiles as PendingFileLite[],
		handleAttachFiles: handleAttachFilesWrapped,
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
		handleDeleteMessage,
		editingMessage,
		handleStartEdit,
		handleCancelEdit,
		handleRemoveExistingFile,
		handleRemoveExistingLocation,
		replyToMessage,
		handleReply,
		cancelReply,
		handleRetryMessage,
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
