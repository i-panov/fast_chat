import { useCallback, useEffect, useRef, useState } from "react";
import type { CallManager } from "../calls/callManager.ts";
import { decryptFileStream } from "../e2ee/file-crypto.ts";
import {
	ensureAccountKeys,
	KeyBackupCheckFailedError,
	LocalLockRequiredError,
	NewKeyConfirmationRequiredError,
	RecoveryRequiredError,
	StaleKeyStateError,
} from "../e2ee/keys.ts";
import i18n from "../i18n.ts";
import {
	retryFailedOps,
	scheduleSync,
	setTokenProvider,
} from "../sync/syncEngine.ts";
import type { Message, PendingFile, TypingPayload } from "../types/api.ts";
import type { ChatPageState } from "../types/chat.ts";
import { useAuth } from "../useAuth";
import { emitNotification } from "../utils/notify.ts";
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
	userId: string | undefined;
	addTypingUser: (payload: TypingPayload) => void;
	clearTyping: (chatId: string, userId: string) => void;
	refreshAccountToken: (
		userId: string,
		oldToken: string,
	) => Promise<{ token: string; expiresAt: string }>;
	sessionExpired: () => void;
	// callManager receives the signaling events of the call domain.
	callManager?: CallManager;
}

function useChatLifecycle({
	token,
	userId,
	addTypingUser,
	clearTyping,
	refreshAccountToken,
	sessionExpired,
	callManager,
}: ChatLifecycleDeps) {
	useEffect(() => {
		setTokenProvider(() => token ?? null);
		// Logout/unmount must stop later ticks from using a token that no
		// longer belongs to an account; otherwise a pending sync can write
		// the signed-out history into the shared pre-account database.
		return () => setTokenProvider(() => null);
	}, [token]);

	// E2E: make sure the account has a key pair and its public key is
	// uploaded before any message is sent.
	useEffect(() => {
		if (token === undefined) return;
		void ensureAccountKeys(token).catch((err) => {
			if (err instanceof KeyBackupCheckFailedError) {
				emitNotification(i18n.t("error.backupCheckFailed"));
				return;
			}
			// Expected key states are surfaced by the UI through their events;
			// they are not failures worth logging.
			if (
				err instanceof RecoveryRequiredError ||
				err instanceof LocalLockRequiredError ||
				err instanceof NewKeyConfirmationRequiredError ||
				err instanceof StaleKeyStateError
			) {
				return;
			}
			console.error("E2E key generation failed:", err);
		});
	}, [token]);

	const handleBackOnline = useCallback(() => {
		void retryFailedOps().then(() => scheduleSync());
	}, []);
	useOnlineNotifications(handleBackOnline);

	useSseEvents({
		token: token ?? "",
		userId,
		addTypingUser,
		clearTyping,
		onTokenExpiring: async (currentToken: string) => {
			if (userId === undefined) {
				sessionExpired();
				return;
			}
			try {
				await refreshAccountToken(userId, currentToken);
			} catch (err) {
				// A 401 already went through the unauthorized handler, which
				// dropped the token. A transient failure must not erase local
				// data or force a logout; the next request retries or 401s.
				if (err instanceof Error && err.message === "unauthorized") {
					sessionExpired();
				}
			}
		},
		onTokenExpired: () => {
			// The session is dead, but the account database and its E2EE key
			// stay: a fresh login on this device must be able to resume.
			sessionExpired();
		},
		callManager,
	});
}

interface ChatActionsDeps {
	activeChatId: string | null;
	removeFile: (id: string) => void;
	clearEditing: () => void;
	setInputText: (text: string) => void;
	clearAllPendingFiles: (keepObjectUrls?: boolean) => void;
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

// forwardAttachments downloads each attachment, decrypts it when the source
// message carried a key, and returns a pending file ready for the normal
// encrypted upload path. The caller revokes the blob URLs after send.
async function forwardAttachments(
	message: Message,
	token: string | undefined,
): Promise<PendingFile[]> {
	const out: PendingFile[] = [];
	for (const file of message.files ?? []) {
		const key =
			(file.hash !== undefined ? message.fileKeys?.[file.hash] : undefined) ??
			message.fileKeys?.[file.id];
		const headers: Record<string, string> = {};
		if (token !== undefined) headers.Authorization = `Bearer ${token}`;
		const response = await fetch(file.url, { headers });
		if (!response.ok) throw new Error(`forward fetch ${response.status}`);
		const blob = await response.blob();
		let plain = blob;
		if (key !== undefined) {
			const plainBytes = await decryptFileStream(
				new Uint8Array(await blob.arrayBuffer()),
				key,
			);
			plain = new Blob([plainBytes as unknown as ArrayBuffer], {
				type: file.mimeType,
			});
		}
		const local = new File([plain], file.originalName, { type: file.mimeType });
		out.push({
			id: crypto.randomUUID(),
			file: local,
			blobUrl: URL.createObjectURL(plain),
			originalName: file.originalName,
			size: plain.size,
			mimeType: file.mimeType,
			fileType: file.fileType,
			encrypted: true,
		});
	}
	return out;
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
		pendingChatIsBot: parts.search.pendingChatIsBot,
		selectPendingChat: parts.search.selectPendingChat,
		cancelPendingChat: parts.search.clearPendingChat,
		handleDeleteMessage: parts.sender.deleteMessage,
		handleForwardMessage: async (targetChatId, message) => {
			if (message.undecryptable === true) return false;
			if (message.text.trim() === "" && (message.files ?? []).length === 0) {
				return false;
			}
			const token = parts.account.activeAccount?.token;
			let pendingFiles: PendingFile[] = [];
			let stored = false;
			try {
				pendingFiles = await forwardAttachments(message, token);
				stored = await parts.sender.sendMessage({
					chatId: targetChatId,
					text: message.text,
					location: message.location,
					pendingFiles,
				});
				return stored;
			} catch {
				return false;
			} finally {
				// A stored row renders the forwarded photo from these previews
				// until the server copy replaces it; the row owns them then.
				if (!stored) {
					for (const file of pendingFiles) {
						URL.revokeObjectURL(file.blobUrl);
					}
				}
			}
		},
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
	const { activeAccount, logout, sessionExpired, refreshAccountToken } =
		useAuth();
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
	// A thread belongs to exactly one chat. After switching chats the old id
	// may still be in state while its thread record is gone; using it would
	// address a thread of another chat and lose the message server-side.
	const activeThreadId =
		threads.activeThread !== null &&
		threads.activeThread.chatId === chatList.activeChatId
			? threads.activeThreadId
			: null;
	const draftKey = `${user?.id ?? "anon"}::${chatList.activeChatId ?? "none"}::${activeThreadId ?? "main"}`;
	// Load the stored draft only when switching conversations. Keystrokes go
	// through setInputText (which writes both the field and the map), so
	// re-running on every drafts change would redo the same setState on
	// each keystroke. The closure holds the drafts of the render that
	// changed the key, which is exactly the current map at switch time.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the draft map is read only on a conversation switch, see above
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

	// Attachments, the picked location, the reply target and the edit target
	// are conversation state, not page state. Keeping them across a switch
	// sends one conversation's private content to another. A ref compares the
	// conversation key after every render; the alternative (a dependency
	// array with draftKey) cannot express "run only when this key changes"
	// without also re-running on every callback identity change.
	const conversationRef = useRef(draftKey);
	useEffect(() => {
		if (conversationRef.current === draftKey) return;
		conversationRef.current = draftKey;
		editor.clearEditing();
		editor.clearReply();
		pendingFiles.clearAllPendingFiles();
		location.clearPendingLocation();
		search.clearPendingChat();
	});

	// Starting an edit must put the current text into the composer: the input
	// is the only value the submit path reads.
	const { handleStartEdit: startEditingMessage, clearReply: clearReplyTarget } =
		editor;
	const startEdit = useCallback(
		(...args: Parameters<typeof startEditingMessage>) => {
			const [, , text] = args;
			startEditingMessage(...args);
			clearReplyTarget();
			setInputText(text);
		},
		[startEditingMessage, clearReplyTarget, setInputText],
	);

	const isOnline = useNetworkStatus();
	const syncState = useSyncStatus();
	const call = useCall(token, user?.id);

	useChatLifecycle({
		token,
		userId: user?.id,
		addTypingUser: typing.addTypingUser,
		clearTyping: typing.clearTyping,
		refreshAccountToken,
		sessionExpired,
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
		pendingChatIsBot: search.pendingChatIsBot,
		activeChatId: chatList.activeChatId,
		activeThreadId,
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
		threads: { ...threads, activeThreadId },
		typing,
		pendingFiles,
		sender,
		location,
		search,
		editor: { ...editor, handleStartEdit: startEdit },
		groups,
		actions,
		call,
		status: { isOnline, syncState },
	});
}
