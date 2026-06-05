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
	addChatMember,
	sendThreadMessage as apiSendThreadMessage,
	createChat,
	deleteChat,
	getChatInfo,
	getConfig,
	removeChatMember,
	searchUsers,
	sendTyping,
	updateChat,
	uploadChatAvatar,
	uploadFile,
} from "../api.ts";
import type { EditingMessage, ReplyTarget } from "../context/ChatPageContext";
import { useAuth } from "../useAuth";
import { useChatList } from "./useChatList";
import { useMessageSender } from "./useMessageSender";
import { useMessages } from "./useMessages";
import { usePendingFiles } from "./usePendingFiles";
import { useSseEvents } from "./useSseEvents";
import { useThreads } from "./useThreads";
import { useTyping } from "./useTyping";

export interface ChatPageState {
	// Auth
	activeAccount: { token: string; user: { id: string; nick: string } } | null;
	user: { id: string; nick: string } | null;
	logout: () => void;

	// UI State
	switcherOpen: boolean;
	setSwitcherOpen: (open: boolean) => void;

	// Chat list
	chats: Chat[];
	activeChatId: string | null;
	activeChat: Chat | undefined;
	selectChat: (chatId: string) => void;

	// Messages
	activeMessages: Message[];
	hasMore: boolean;
	isLoadingMore: boolean;
	loadMoreMessages: (chatId: string | null) => Promise<void>;

	// Threads
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

	// Typing
	typingUsers: Record<string, TypingPayload[]>;
	handleTyping: (chatId: string, active: boolean) => void;

	// Pending files
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

	// Config
	config: { messageEditTTL: number; messageDeleteTTL: number } | null;

	// Search
	searchQuery: string;
	searchResults: User[];
	showSearchResults: boolean;
	handleSearchChange: (value: string) => void;

	// Pending chat
	pendingChatWith: string | null;
	pendingChatNick: string | null;
	selectPendingChat: (withUserId: string, withUserNick: string) => void;

	// Input
	inputText: string;
	setInputText: (v: string) => void;

	// Send
	handleSend: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
	handleSendThreadMessage: (
		e: React.FormEvent<HTMLFormElement>,
	) => Promise<void>;

	// Delete
	handleDeleteMessage: (chatId: string, messageId: string) => void;

	// Edit
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

	// Reply
	replyToMessage: ReplyTarget | null;
	handleReply: (chatId: string, messageId: string) => void;
	cancelReply: () => void;

	// Retry
	handleRetryMessage: (chatId: string, messageId: string) => Promise<void>;
	handleRetryThreadMessage: (
		threadId: string,
		messageId: string,
	) => Promise<void>;

	// Location
	pendingLocation: Location | null;
	locationPickerOpen: boolean;
	setLocationPickerOpen: (v: boolean) => void;
	openLocationPicker: () => void;
	handleLocationConfirm: (loc: Location) => void;
	handleRemovePendingLocation: () => void;

	// Group
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
	const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(
		null,
	);
	const [replyToMessage, setReplyToMessage] = useState<ReplyTarget | null>(
		null,
	);
	const [pendingLocation, setPendingLocation] = useState<Location | null>(null);
	const [locationPickerOpen, setLocationPickerOpen] = useState(false);
	const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
	const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<User[]>([]);
	const [showSearchResults, setShowSearchResults] = useState(false);
	const [createGroupOpen, setCreateGroupOpen] = useState(false);
	const [groupSettingsChatId, setGroupSettingsChatId] = useState<string | null>(
		null,
	);
	const [groupSettings, setGroupSettings] = useState<Chat | null>(null);

	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
	} = useThreads({ token, chatId: activeChatId });
	const { typingUsers, addTypingUser, clearTyping } = useTyping({ token });
	const {
		pendingFiles,
		setPendingFiles,
		handleAttachFiles,
		handleRemoveFile: removeFile,
	} = usePendingFiles();
	const { sendMessage, editMessage, deleteMessage, retryMessage, uploadFiles } =
		useMessageSender({
			token: token ?? "",
			userId: user?.id ?? "",
			userNick: user?.nick ?? "",
		});

	// Load config
	useEffect(() => {
		getConfig()
			.then((cfg) => setConfig(cfg))
			.catch(() => {});
	}, []);

	// SSE events
	useSseEvents({
		token: token ?? "",
		setChats: () => {},
		setMessages: () => {},
		setThreads: () => {},
		setThreadMessages: () => {},
		setMessageToThread: () => {},
		addTypingUser,
		clearTyping,
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

	// Search
	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchQuery(value);

			if (!value.trim()) {
				setSearchResults([]);
				setShowSearchResults(false);
				return;
			}

			if (searchTimerRef.current) {
				clearTimeout(searchTimerRef.current);
			}

			searchTimerRef.current = setTimeout(async () => {
				if (!token) return;
				try {
					const { users } = await searchUsers(token, value);
					setSearchResults(users);
					setShowSearchResults(true);
				} catch {
					setShowSearchResults(false);
				}
			}, 300);
		},
		[token],
	);

	useEffect(() => {
		return () => {
			if (searchTimerRef.current) {
				clearTimeout(searchTimerRef.current);
			}
		};
	}, []);

	// Pending chat
	const selectPendingChat = useCallback(
		(withUserId: string, withUserNick: string) => {
			setPendingChatWith(withUserId);
			setPendingChatNick(withUserNick);
		},
		[],
	);

	// Send
	const handleSend = useCallback(
		async (e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (!token || !user) return;

			const text = inputText.trim();
			if (!text && pendingFiles.length === 0 && !pendingLocation) return;

			const msgId = crypto.randomUUID();
			let fileIDs: string[] = [];

			if (pendingFiles.length > 0) {
				fileIDs = await uploadFiles(pendingFiles);
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
						fileIDs.length > 0
							? fileIDs
							: editingMessage.files?.map((f) => f.id),
					location: location ?? null,
					clearLocation: location === null,
					isThread: !!editingMessage.threadId,
					threadId: editingMessage.threadId,
				});
				setEditingMessage(null);
			} else if (pendingChatWith !== null) {
				const { chat } = await createChat(token, {
					type: "private",
					withUserId: pendingChatWith,
				});
				selectChat(chat.id);
				await sendMessage({
					chatId: chat.id,
					text,
					msgId,
					fileIDs,
					location: pendingLocation ?? undefined,
				});
				setPendingChatWith(null);
				setPendingChatNick(null);
			} else if (activeChatId !== null) {
				await sendMessage({
					chatId: activeChatId,
					text,
					msgId,
					replyToId: replyToMessage?.messageId,
					fileIDs,
					location: pendingLocation ?? undefined,
				});
			}

			setInputText("");
			setPendingFiles([]);
			setReplyToMessage(null);
			setPendingLocation(null);
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
			setPendingFiles,
		],
	);

	const handleSendThreadMessage = useCallback(
		async (e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (!token || !activeThreadId || !activeChatId) return;

			const text = inputText.trim();
			if (!text && pendingFiles.length === 0 && !pendingLocation) return;

			const msgId = crypto.randomUUID();
			let fileIDs: string[] = [];

			if (pendingFiles.length > 0) {
				fileIDs = await uploadFiles(pendingFiles);
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
						fileIDs.length > 0
							? fileIDs
							: editingMessage.files?.map((f) => f.id),
					location: location ?? null,
					clearLocation: location === null,
					isThread: true,
					threadId: editingMessage.threadId,
				});
				setEditingMessage(null);
			} else {
				await sendMessage({
					chatId: activeChatId,
					text,
					msgId,
					replyToId: replyToMessage?.messageId,
					fileIDs,
					location: pendingLocation ?? undefined,
					isThread: true,
					threadId: activeThreadId,
				});
			}

			setInputText("");
			setPendingFiles([]);
			setReplyToMessage(null);
			setPendingLocation(null);
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
			uploadFiles,
			editMessage,
			sendMessage,
			setPendingFiles,
		],
	);

	// Delete
	const handleDeleteMessage = useCallback(
		(chatId: string, messageId: string) => {
			deleteMessage(chatId, messageId);
		},
		[deleteMessage],
	);

	// Edit
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

	const handleCancelEdit = useCallback(() => {
		setEditingMessage(null);
	}, []);

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

	// Reply
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

	// Retry
	const handleRetryMessage = useCallback(
		async (chatId: string, messageId: string) => {
			const msg =
				activeMessages.find((m) => m.id === messageId) ??
				activeThreadMessages.find((m) => m.id === messageId);
			if (!msg) return;
			await retryMessage(chatId, messageId, msg.text);
		},
		[activeMessages, activeThreadMessages, retryMessage],
	);

	const handleRetryThreadMessage = useCallback(
		async (threadId: string, messageId: string) => {
			const msg = activeThreadMessages.find((m) => m.id === messageId);
			if (!msg || !token || !activeThread) return;
			await apiSendThreadMessage(
				token,
				activeThread.chatId,
				threadId,
				msg.text,
				messageId,
			);
		},
		[activeThreadMessages, token, activeThread],
	);

	// Location
	const openLocationPicker = useCallback(() => {
		setLocationPickerOpen(true);
	}, []);

	const handleLocationConfirm = useCallback((loc: Location) => {
		setPendingLocation(loc);
		setLocationPickerOpen(false);
	}, []);

	const handleRemovePendingLocation = useCallback(() => {
		setPendingLocation(null);
	}, []);

	// Group
	const handleCreateGroup = useCallback(
		async (name: string, memberIds: string[]) => {
			if (!token) return;
			await createChat(token, { type: "group", name, memberIds });
		},
		[token],
	);

	const openGroupSettings = useCallback(
		async (chatId: string) => {
			if (!token) return;
			setGroupSettingsChatId(chatId);
			try {
				const { chat } = await getChatInfo(token, chatId);
				setGroupSettings(chat);
			} catch {
				setGroupSettingsChatId(null);
			}
		},
		[token],
	);

	const closeGroupSettings = useCallback(() => {
		setGroupSettingsChatId(null);
		setGroupSettings(null);
	}, []);

	const handleRenameGroup = useCallback(
		async (name: string) => {
			if (!token || !groupSettingsChatId) return;
			const { chat } = await updateChat(token, groupSettingsChatId, { name });
			setGroupSettings(chat);
		},
		[token, groupSettingsChatId],
	);

	const handleAddGroupMember = useCallback(
		async (userId: string) => {
			if (!token || !groupSettingsChatId) return;
			const { chat } = await addChatMember(token, groupSettingsChatId, userId);
			setGroupSettings(chat);
		},
		[token, groupSettingsChatId],
	);

	const handleRemoveGroupMember = useCallback(
		async (userId: string) => {
			if (!token || !groupSettingsChatId) return;
			const { chat } = await removeChatMember(
				token,
				groupSettingsChatId,
				userId,
			);
			setGroupSettings(chat);
		},
		[token, groupSettingsChatId],
	);

	const handleDeleteGroup = useCallback(async () => {
		if (!token || !groupSettingsChatId) return;
		await deleteChat(token, groupSettingsChatId);
		closeGroupSettings();
	}, [token, groupSettingsChatId, closeGroupSettings]);

	const handleUploadGroupAvatar = useCallback(
		async (file: File) => {
			if (!token || !groupSettingsChatId) return;
			const { file: uploaded } = await uploadFile(token, file);
			const { chat } = await uploadChatAvatar(
				token,
				groupSettingsChatId,
				uploaded.id,
			);
			setGroupSettings(chat);
		},
		[token, groupSettingsChatId],
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
