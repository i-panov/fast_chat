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
import { createChat, getConfig, sendTyping } from "../api.ts";
import type { EditingMessage, ReplyTarget } from "../context/ChatPageContext";
import i18n from "../i18n.ts";
import { useAuth } from "../useAuth";
import { emitNotification } from "../utils/notify.ts";
import { useChatList } from "./useChatList";
import { useGroupSettings } from "./useGroupSettings";
import { useLocationPicker } from "./useLocationPicker";
import { useMessageEditor } from "./useMessageEditor";
import { useMessageSearch } from "./useMessageSearch";
import { useMessageSender } from "./useMessageSender";
import { useMessages } from "./useMessages";
import { usePendingFiles } from "./usePendingFiles";
import { useSseEvents } from "./useSseEvents";
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
	selectChat: (chatId: string) => void;

	activeMessages: Message[];
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

	pendingFiles: Array<{
		id: string;
		file: File;
		blobUrl: string;
		originalName: string;
		size: number;
		mimeType: string;
		fileType: "photo" | "video" | "audio" | "file";
	}>;
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
export { usePendingFiles } from "./usePendingFiles";
export { useSseEvents } from "./useSseEvents";
export { useThreads } from "./useThreads";
export { useTyping } from "./useTyping";

export function useChatPage(): ChatPageState {
	const { activeAccount, logout } = useAuth();
	const user = activeAccount?.user ?? null;
	const token = activeAccount?.token;

	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [config, setConfig] = useState<ChatPageState["config"]>(null);
	const [inputText, setInputText] = useState("");

	const [messagesMap, setMessagesMap] = useState<Record<string, Message[]>>({});
	const [threadsMap, setThreadsMap] = useState<Record<string, Thread>>({});
	const [messageToThreadMap, setMessageToThreadMap] = useState<
		Record<string, string>
	>({});
	const [threadMessagesMap, setThreadMessagesMap] = useState<
		Record<string, Message[]>
	>({});

	const configAbortRef = useRef<AbortController | null>(null);

	const { chats, setChats, activeChatId, activeChat, selectChat } = useChatList(
		{
			token,
		},
	);
	const {
		messages: activeMessages,
		hasMore,
		isLoadingMore,
		loadMore,
	} = useMessages({
		token,
		chatId: activeChatId,
		messagesMap,
		setMessagesMap,
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
	const { sendMessage, editMessage, deleteMessage, retryMessage, uploadFiles } =
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
		setChats,
		selectChat,
	});

	const loadChatsRef = useRef<(() => Promise<void>) | null>(null);
	const loadChats = useCallback(async () => {
		if (!token) return;
		try {
			const { chats: fetchedChats } = await (
				await import("../api.ts")
			).getChats(token);
			setChats(fetchedChats);
		} catch {
			/* handled in useChatList */
		}
	}, [token, setChats]);
	loadChatsRef.current = loadChats;

	const markMessageStatus = useCallback(
		(
			chatId: string,
			msgId: string,
			status: "sending" | "failed",
			threadId?: string,
		) => {
			if (threadId !== undefined) {
				setThreadMessagesMap((prev) => {
					const list = prev[threadId];
					if (list === undefined) return prev;
					return {
						...prev,
						[threadId]: list.map((m) =>
							m.id === msgId ? { ...m, status } : m,
						),
					};
				});
			} else {
				setMessagesMap((prev) => {
					const list = prev[chatId];
					if (list === undefined) return prev;
					return {
						...prev,
						[chatId]: list.map((m) => (m.id === msgId ? { ...m, status } : m)),
					};
				});
			}
		},
		[],
	);

	const insertOptimistic = useCallback((msg: Message, threadId?: string) => {
		if (threadId !== undefined) {
			setThreadMessagesMap((prev) => ({
				...prev,
				[threadId]: [...(prev[threadId] ?? []), msg],
			}));
		} else {
			setMessagesMap((prev) => ({
				...prev,
				[msg.chatId]: [...(prev[msg.chatId] ?? []), msg],
			}));
		}
	}, []);

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
		setChats,
		setMessagesMap,
		setThreadsMap,
		setThreadMessagesMap,
		setMessageToThreadMap,
		addTypingUser,
		clearTyping,
		onSseClosed: () => {
			loadChatsRef.current?.();
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

			const msgId = crypto.randomUUID();
			let fileInfos: FileInfo[] = [];

			if (pendingFiles.length > 0) {
				fileInfos = await uploadFiles(pendingFiles);
			}

			if (editingMessage !== null) {
				const location =
					editingMessage.location === undefined
						? undefined
						: editingMessage.location;
				await editMessage({
					chatId: editingMessage.chatId,
					messageId: editingMessage.messageId,
					text,
					fileIDs:
						fileInfos.length > 0
							? fileInfos.map((f) => f.id)
							: editingMessage.files?.map((f) => f.id),
					location: location ?? null,
					clearLocation: location === null,
					isThread: !!editingMessage.threadId,
					threadId: editingMessage.threadId,
				});
				clearEditing();
			} else if (pendingChatWith !== null) {
				const { chat } = await createChat(token, {
					type: "private",
					withUserId: pendingChatWith,
				});
				setChats((prev) => {
					if (prev.some((c) => c.id === chat.id)) return prev;
					return [...prev, chat];
				});
				selectChat(chat.id);
				insertOptimistic({
					id: msgId,
					chatId: chat.id,
					fromId: user.id,
					fromNick: user.nick,
					text,
					createdAt: new Date().toISOString(),
					files: fileInfos.length > 0 ? fileInfos : undefined,
					location: pendingLocation ?? undefined,
					status: "sending",
				});
				try {
					await sendMessage({
						chatId: chat.id,
						text,
						msgId,
						fileIDs: fileInfos.map((f) => f.id),
						location: pendingLocation ?? undefined,
					});
				} catch {
					markMessageStatus(chat.id, msgId, "failed");
					emitNotification(i18n.t("error.send"));
				}
				clearPendingChat();
			} else if (activeChatId !== null) {
				insertOptimistic({
					id: msgId,
					chatId: activeChatId,
					fromId: user.id,
					fromNick: user.nick,
					text,
					createdAt: new Date().toISOString(),
					files: fileInfos.length > 0 ? fileInfos : undefined,
					location: pendingLocation ?? undefined,
					status: "sending",
				});
				try {
					await sendMessage({
						chatId: activeChatId,
						text,
						msgId,
						replyToId: replyToMessage?.messageId,
						fileIDs: fileInfos.map((f) => f.id),
						location: pendingLocation ?? undefined,
					});
				} catch {
					markMessageStatus(activeChatId, msgId, "failed");
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
			user,
			inputText,
			pendingFiles,
			pendingLocation,
			editingMessage,
			pendingChatWith,
			activeChatId,
			replyToMessage,
			uploadFiles,
			editMessage,
			sendMessage,
			selectChat,
			clearAllPendingFiles,
			setChats,
			insertOptimistic,
			markMessageStatus,
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
			let fileInfos: FileInfo[] = [];

			if (pendingFiles.length > 0) {
				fileInfos = await uploadFiles(pendingFiles);
			}

			if (editingMessage?.threadId) {
				const location =
					editingMessage.location === undefined
						? undefined
						: editingMessage.location;
				await editMessage({
					chatId: editingMessage.chatId,
					messageId: editingMessage.messageId,
					text,
					fileIDs:
						fileInfos.length > 0
							? fileInfos.map((f) => f.id)
							: editingMessage.files?.map((f) => f.id),
					location: location ?? null,
					clearLocation: location === null,
					isThread: true,
					threadId: editingMessage.threadId,
				});
				clearEditing();
			} else {
				insertOptimistic(
					{
						id: msgId,
						chatId: activeChatId,
						fromId: user?.id ?? "",
						fromNick: user?.nick ?? "",
						text,
						createdAt: new Date().toISOString(),
						files: fileInfos.length > 0 ? fileInfos : undefined,
						location: pendingLocation ?? undefined,
						status: "sending",
					},
					activeThreadId,
				);
				try {
					await sendMessage({
						chatId: activeChatId,
						text,
						msgId,
						replyToId: replyToMessage?.messageId,
						fileIDs: fileInfos.map((f) => f.id),
						location: pendingLocation ?? undefined,
						isThread: true,
						threadId: activeThreadId,
					});
				} catch {
					markMessageStatus(activeChatId, msgId, "failed", activeThreadId);
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
			uploadFiles,
			editMessage,
			sendMessage,
			clearAllPendingFiles,
			insertOptimistic,
			markMessageStatus,
			clearEditing,
			clearReply,
			clearPendingLocation,
		],
	);

	const handleDeleteMessage = useCallback(
		(chatId: string, messageId: string) => {
			deleteMessage(chatId, messageId);
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
			const msg = activeMessages.find((m) => m.id === messageId);
			if (!msg) return;
			markMessageStatus(chatId, messageId, "sending");
			try {
				await retryMessage(chatId, messageId, msg.text);
			} catch {
				markMessageStatus(chatId, messageId, "failed");
				emitNotification(i18n.t("error.send"));
			}
		},
		[activeMessages, retryMessage, markMessageStatus],
	);

	const handleRetryThreadMessage = useCallback(
		async (threadId: string, messageId: string) => {
			const msg = activeThreadMessages.find((m) => m.id === messageId);
			if (!msg || !activeThread) return;
			markMessageStatus(activeThread.chatId, messageId, "sending", threadId);
			try {
				await retryMessage(
					activeThread.chatId,
					messageId,
					msg.text,
					true,
					threadId,
				);
			} catch {
				markMessageStatus(activeThread.chatId, messageId, "failed", threadId);
				emitNotification(i18n.t("error.send"));
			}
		},
		[activeThreadMessages, activeThread, retryMessage, markMessageStatus],
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
		pendingFiles,
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
	};
}
