import { useCallback, useEffect, useState } from "react";
import { refreshToken } from "../api.ts";
import type { CallManager } from "../calls/callManager.ts";
import { ensureAccountKeys, RecoveryRequiredError } from "../e2ee/keys.ts";
import {
	retryFailedOps,
	scheduleSync,
	setTokenProvider,
} from "../sync/syncEngine.ts";
import type { TypingPayload } from "../types/api.ts";
import type { ChatPageState } from "../types/chat.ts";
import { useAuth } from "../useAuth";
import { useCall } from "./useCall.ts";
import { useChatList } from "./useChatList";
import { useChatSubmit } from "./useChatSubmit";
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

interface ChatLifecycleDeps {
	token: string | undefined;
	addTypingUser: (payload: TypingPayload) => void;
	clearTyping: (chatId: string, userId: string) => void;
	updateAccountToken: (
		oldToken: string,
		newToken: string,
		newExpiresAt: string,
	) => void;
	logout: () => void;
	// callManager receives the signaling events of the call domain.
	callManager?: CallManager;
}

function useChatLifecycle({
	token,
	addTypingUser,
	clearTyping,
	updateAccountToken,
	logout,
	callManager,
}: ChatLifecycleDeps) {
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
		callManager,
	});
}

interface ChatActionsDeps {
	activeChatId: string | null;
	removeFile: (id: string) => void;
	clearEditing: () => void;
	setInputText: (text: string) => void;
	clearAllPendingFiles: () => void;
	clearPendingLocation: () => void;
	clearReply: () => void;
	deleteMessage: (
		chatId: string,
		messageId: string,
		threadId?: string,
	) => Promise<void>;
	retryMessage: (
		chatId: string,
		messageId: string,
		threadId?: string,
	) => Promise<void>;
}

function useChatActions({
	activeChatId,
	removeFile,
	clearEditing,
	setInputText,
	clearAllPendingFiles,
	clearPendingLocation,
	clearReply,
	deleteMessage,
	retryMessage,
}: ChatActionsDeps) {
	const handleRemoveFile = useCallback(
		(id: string) => {
			removeFile(id);
		},
		[removeFile],
	);

	const handleCancelEdit = useCallback(() => {
		clearEditing();
		setInputText("");
		clearAllPendingFiles();
		clearPendingLocation();
		clearReply();
	}, [
		clearEditing,
		setInputText,
		clearAllPendingFiles,
		clearPendingLocation,
		clearReply,
	]);

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
		handleRemoveFile,
		handleCancelEdit,
		handleDeleteThreadMessage,
		handleRetryThreadMessage,
	};
}

interface ChatPageStateParts {
	account: {
		activeAccount: ChatPageState["activeAccount"];
		user: ChatPageState["user"];
		logout: ChatPageState["logout"];
	};
	ui: {
		switcherOpen: ChatPageState["switcherOpen"];
		setSwitcherOpen: ChatPageState["setSwitcherOpen"];
		config: ChatPageState["config"];
		inputText: ChatPageState["inputText"];
		setInputText: ChatPageState["setInputText"];
		handleSend: ChatPageState["handleSend"];
		handleSendThreadMessage: ChatPageState["handleSendThreadMessage"];
	};
	chatList: ReturnType<typeof useChatList>;
	messages: ReturnType<typeof useMessages>;
	threads: ReturnType<typeof useThreads>;
	typing: ReturnType<typeof useTyping>;
	pendingFiles: ReturnType<typeof usePendingFiles>;
	sender: ReturnType<typeof useMessageSender>;
	location: ReturnType<typeof useLocationPicker>;
	search: ReturnType<typeof useMessageSearch>;
	editor: ReturnType<typeof useMessageEditor>;
	groups: ReturnType<typeof useGroupSettings>;
	actions: ReturnType<typeof useChatActions>;
	call: ReturnType<typeof useCall>;
	status: {
		isOnline: ChatPageState["isOnline"];
		syncState: ChatPageState["syncState"];
	};
}

function buildChatPageState(parts: ChatPageStateParts): ChatPageState {
	return {
		activeAccount: parts.account.activeAccount,
		user: parts.account.user,
		logout: parts.account.logout,
		switcherOpen: parts.ui.switcherOpen,
		setSwitcherOpen: parts.ui.setSwitcherOpen,
		config: parts.ui.config,
		inputText: parts.ui.inputText,
		setInputText: parts.ui.setInputText,
		handleSend: parts.ui.handleSend,
		handleSendThreadMessage: parts.ui.handleSendThreadMessage,
		...parts.chatList,
		activeMessages: parts.messages.messages,
		hasMore: parts.messages.hasMore,
		isLoadingMore: parts.messages.isLoadingMore,
		loadMoreMessages: parts.messages.loadMore,
		threads: parts.threads.threads,
		messageToThread: parts.threads.messageToThread,
		activeThreadId: parts.threads.activeThreadId,
		activeThread: parts.threads.activeThread,
		activeThreadMessages: parts.threads.activeThreadMessages,
		threadHasMore: parts.threads.threadHasMore,
		threadIsLoadingMore: parts.threads.threadIsLoadingMore,
		handleOpenThread: parts.threads.openThread,
		handleCloseThread: parts.threads.closeThread,
		loadMoreThreadMessages: parts.threads.loadMoreThreadMessages,
		handleCreateThread: parts.threads.createThread,
		typingUsers: parts.typing.typingUsers,
		handleTyping: parts.typing.handleTyping,
		pendingFiles: parts.pendingFiles.pendingFiles,
		handleAttachFiles: parts.pendingFiles.handleAttachFiles,
		handleRemoveFile: parts.actions.handleRemoveFile,
		searchQuery: parts.search.searchQuery,
		searchResults: parts.search.searchResults,
		showSearchResults: parts.search.showSearchResults,
		handleSearchChange: parts.search.handleSearchChange,
		pendingChatWith: parts.search.pendingChatWith,
		pendingChatNick: parts.search.pendingChatNick,
		selectPendingChat: parts.search.selectPendingChat,
		handleDeleteMessage: parts.sender.deleteMessage,
		editingMessage: parts.editor.editingMessage,
		handleStartEdit: parts.editor.handleStartEdit,
		handleCancelEdit: parts.actions.handleCancelEdit,
		handleRemoveExistingFile: parts.editor.handleRemoveExistingFile,
		handleRemoveExistingLocation: parts.editor.handleRemoveExistingLocation,
		replyToMessage: parts.editor.replyToMessage,
		handleReply: parts.editor.handleReply,
		cancelReply: parts.editor.cancelReply,
		handleRetryMessage: parts.sender.retryMessage,
		handleCancelSendMessage: parts.sender.cancelSendMessage,
		handleDeleteThreadMessage: parts.actions.handleDeleteThreadMessage,
		handleRetryThreadMessage: parts.actions.handleRetryThreadMessage,
		...parts.location,
		...parts.groups,
		call: parts.call.state,
		startCall: parts.call.start,
		acceptCall: parts.call.accept,
		rejectCall: parts.call.reject,
		hangupCall: parts.call.hangup,
		toggleCallMute: parts.call.toggleMute,
		toggleCallCamera: parts.call.toggleCamera,
		dismissCall: parts.call.dismiss,
		isOnline: parts.status.isOnline,
		syncState: parts.status.syncState,
	};
}

// Cap for per-conversation input drafts kept in memory.
const MAX_DRAFTS = 50;

export function useChatPage(): ChatPageState {
	const { activeAccount, logout, updateAccountToken } = useAuth();
	const user = activeAccount?.user ?? null;
	const token = activeAccount?.token;
	const { config } = useServerConfig(token);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [inputText, setInputTextState] = useState("");
	// Per-chat/per-account (+thread) drafts so switching chats or accounts
	// neither loses text nor leaks it into another conversation. Every
	// keystroke is written through to the map, so switching only loads.
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	const chatList = useChatList({ token });
	const messages = useMessages({ token, chatId: chatList.activeChatId });
	const threads = useThreads({ token, chatId: chatList.activeChatId });
	const draftKey = `${user?.id ?? "anon"}::${chatList.activeChatId ?? "none"}::${threads.activeThreadId ?? "main"}`;
	// Load the stored draft only when switching conversations. Keystrokes go
	// through setInputText (which writes both the field and the map), so
	// re-running on every drafts change would redo the same setState on
	// each keystroke. The closure holds the drafts of the render that
	// changed the key, which is exactly the current map at switch time.
	useEffect(() => {
		setInputTextState(drafts[draftKey] ?? "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draftKey]);
	const setInputText = useCallback(
		(value: string) => {
			setInputTextState(value);
			setDrafts((prev) => {
				if (prev[draftKey] === value) return prev;
				const next = { ...prev, [draftKey]: value };
				// Bound memory: drop the oldest entries past the cap.
				const keys = Object.keys(next);
				if (keys.length > MAX_DRAFTS) {
					for (const k of keys.slice(0, keys.length - MAX_DRAFTS)) {
						delete next[k];
					}
				}
				return next;
			});
		},
		[draftKey],
	);
	const typing = useTyping({ token });
	const pendingFiles = usePendingFiles();
	const sender = useMessageSender({ token });
	const location = useLocationPicker();
	const search = useMessageSearch(token);
	const editor = useMessageEditor(messages.messages);
	const groups = useGroupSettings({
		token,
		userId: user?.id,
		activeChatId: chatList.activeChatId,
		selectChat: chatList.selectChat,
	});

	const isOnline = useNetworkStatus();
	const syncState = useSyncStatus();
	const call = useCall(token, user?.id);

	useChatLifecycle({
		token,
		addTypingUser: typing.addTypingUser,
		clearTyping: typing.clearTyping,
		updateAccountToken,
		logout,
		callManager: call.manager ?? undefined,
	});

	const {
		handleRemoveFile,
		handleCancelEdit,
		handleDeleteThreadMessage,
		handleRetryThreadMessage,
	} = useChatActions({
		activeChatId: chatList.activeChatId,
		removeFile: pendingFiles.handleRemoveFile,
		clearEditing: editor.clearEditing,
		setInputText,
		clearAllPendingFiles: pendingFiles.clearAllPendingFiles,
		clearPendingLocation: location.clearPendingLocation,
		clearReply: editor.clearReply,
		deleteMessage: sender.deleteMessage,
		retryMessage: sender.retryMessage,
	});
	const actions = {
		handleRemoveFile,
		handleCancelEdit,
		handleDeleteThreadMessage,
		handleRetryThreadMessage,
	};

	const handleSubmit = useChatSubmit({
		token,
		user,
		inputText,
		pendingFiles: pendingFiles.pendingFiles,
		pendingLocation: location.pendingLocation,
		editingMessage: editor.editingMessage,
		pendingChatWith: search.pendingChatWith,
		activeChatId: chatList.activeChatId,
		activeThreadId: threads.activeThreadId,
		replyToMessage: editor.replyToMessage,
		sendMessage: sender.sendMessage,
		editMessage: sender.editMessage,
		selectChat: chatList.selectChat,
		closeThread: threads.closeThread,
		clearAllPendingFiles: pendingFiles.clearAllPendingFiles,
		clearEditing: editor.clearEditing,
		clearPendingChat: search.clearPendingChat,
		clearReply: editor.clearReply,
		clearPendingLocation: location.clearPendingLocation,
		setInputText,
	});

	return buildChatPageState({
		account: { activeAccount: activeAccount ?? null, user, logout },
		ui: {
			switcherOpen,
			setSwitcherOpen,
			config,
			inputText,
			setInputText,
			handleSend: handleSubmit,
			handleSendThreadMessage: handleSubmit,
		},
		chatList,
		messages,
		threads,
		typing,
		pendingFiles,
		sender,
		location,
		search,
		editor,
		groups,
		actions,
		call,
		status: { isOnline, syncState },
	});
}
