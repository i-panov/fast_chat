import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AppConfig,
	Chat,
	FileInfo,
	Message,
	PendingFile,
	Thread,
	TypingPayload,
	User,
} from "../api.ts";
import {
	createThread as apiCreateThread,
	getThreadMessages as apiGetThreadMessages,
	getThreads as apiGetThreads,
	sendThreadMessage as apiSendThreadMessage,
	createChat,
	deleteMessage,
	editMessage,
	editThreadMessage,
	getChats,
	getConfig,
	getMessages,
	searchUsers,
	sendMessage,
	sendTyping,
	uploadFile,
} from "../api.ts";
import i18n from "../i18n.ts";
import { useAuth } from "../useAuth.tsx";
import { useSse } from "../useSse.ts";
import { emitNotification } from "../utils/notify.ts";

const SEARCH_DEBOUNCE_MS = 300;

const SEEN_IDS_MAX = 1000;

function useAuthGuard() {
	const { activeAccount } = useAuth();
	const navigate = useNavigate();

	useEffect(() => {
		if (activeAccount === null) {
			navigate({ to: "/login" });
		}
	}, [activeAccount, navigate]);
}

function useTokenChange(
	token: string | undefined,
	setChats: (c: Chat[]) => void,
	setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>,
	messagesRef: React.MutableRefObject<Record<string, Message[]>>,
	nextCursorsRef: React.MutableRefObject<Record<string, string | null>>,
	setHasMoreMap: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
) {
	useEffect(() => {
		if (token === undefined || token === "") {
			return;
		}

		messagesRef.current = {};
		setMessages({});
		nextCursorsRef.current = {};
		setHasMoreMap({});
		getChats(token)
			.then(({ chats: fetchedChats }) => {
				setChats(fetchedChats);
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadChats"));
			});
	}, [
		token,
		setChats,
		setMessages,
		messagesRef,
		nextCursorsRef,
		setHasMoreMap,
	]);
}

function useSearch(
	token: string | undefined,
	query: string,
	setResults: (r: User[]) => void,
) {
	useEffect(() => {
		if (query.length === 0 || token === undefined) {
			return;
		}

		const timer = setTimeout(() => {
			searchUsers(token, query)
				.then(({ users }) => {
					setResults(users);
				})
				.catch(() => {
					emitNotification(i18n.t("error.search"));
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
		};
	}, [query, token, setResults]);
}

// biome-ignore lint/complexity/useMaxParams: all params are required for SSE event routing
function useSseMessages(
	token: string,
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>,
	setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>,
	setThreads: React.Dispatch<React.SetStateAction<Record<string, Thread>>>,
	setThreadMessages: React.Dispatch<
		React.SetStateAction<Record<string, Message[]>>
	>,
	setMessageToThread: React.Dispatch<
		React.SetStateAction<Record<string, string>>
	>,
	setTypingUsers: React.Dispatch<
		React.SetStateAction<Record<string, TypingPayload[]>>
	>,
	typingTimersRef: React.MutableRefObject<Record<string, number>>,
) {
	const seenIds = useRef<string[]>([]);

	const handler = useCallback(
		(event: string, data: unknown) => {
			if (event === "new_message") {
				const msg = data as Message;
				if (seenIds.current.includes(msg.id)) return;

				seenIds.current.push(msg.id);
				if (seenIds.current.length > SEEN_IDS_MAX) {
					seenIds.current = seenIds.current.slice(-SEEN_IDS_MAX);
				}

				setMessages((prev) => {
					const list = prev[msg.chatId] ?? [];
					const idx = list.findIndex((m) => m.id === msg.id);
					if (idx !== -1) {
						const next = [...list];
						next[idx] = msg;
						return { ...prev, [msg.chatId]: next };
					}
					return {
						...prev,
						[msg.chatId]: [...list, msg],
					};
				});
			} else if (event === "message_updated") {
				const msg = data as Message;
				setMessages((prev) => {
					const msgs = prev[msg.chatId];
					if (msgs === undefined) return prev;
					return {
						...prev,
						[msg.chatId]: msgs.map((m) => (m.id === msg.id ? msg : m)),
					};
				});
			} else if (event === "chat_created") {
				const chat = data as Chat;
				setChats((prev) => {
					if (prev.some((c) => c.id === chat.id)) return prev;
					return [...prev, chat];
				});
			} else if (event === "message_deleted") {
				const { chatId, messageId } = data as {
					chatId: string;
					messageId: string;
				};
				setMessages((prev) => ({
					...prev,
					[chatId]: (prev[chatId] ?? []).filter((m) => m.id !== messageId),
				}));
			} else if (event === "thread_created") {
				const thread = data as Thread;
				setThreads((prev) => {
					if (prev[thread.id] !== undefined) return prev;
					return { ...prev, [thread.id]: thread };
				});
				setMessageToThread((prev) => ({
					...prev,
					[thread.parentMessageId]: thread.id,
				}));
			} else if (event === "thread_message_new") {
				const { threadId, message } = data as {
					threadId: string;
					message: Message;
				};
				setThreadMessages((prev) => {
					const list = prev[threadId] ?? [];
					const idx = list.findIndex((m) => m.id === message.id);
					if (idx !== -1) {
						const next = [...list];
						next[idx] = message;
						return { ...prev, [threadId]: next };
					}
					return {
						...prev,
						[threadId]: [...list, message],
					};
				});
				setThreads((prev) => {
					const t = prev[threadId];
					if (t === undefined) return prev;
					return {
						...prev,
						[threadId]: { ...t, messageCount: t.messageCount + 1 },
					};
				});
			} else if (event === "thread_message_updated") {
				const { threadId, message } = data as {
					threadId: string;
					message: Message;
				};
				setThreadMessages((prev) => {
					const list = prev[threadId];
					if (list === undefined) return prev;
					return {
						...prev,
						[threadId]: list.map((m) => (m.id === message.id ? message : m)),
					};
				});
			} else if (event === "typing") {
				const payload = data as TypingPayload;
				setTypingUsers((prev) => {
					const list = prev[payload.chatId] ?? [];
					if (list.some((t) => t.userId === payload.userId)) return prev;
					return { ...prev, [payload.chatId]: [...list, payload] };
				});
				const timerKey = `${payload.chatId}:${payload.userId}`;
				if (typingTimersRef.current[timerKey] !== undefined) {
					clearTimeout(typingTimersRef.current[timerKey]);
				}
				typingTimersRef.current[timerKey] = window.setTimeout(() => {
					setTypingUsers((prev) => {
						const list = (prev[payload.chatId] ?? []).filter(
							(t) => t.userId !== payload.userId,
						);
						if (list.length === 0) {
							// eslint-disable-next-line @typescript-eslint/no-unused-vars
							const { [payload.chatId]: _, ...rest } = prev;
							return rest;
						}
						return { ...prev, [payload.chatId]: list };
					});
					delete typingTimersRef.current[timerKey];
				}, 3000);
			} else if (event === "typing_stop") {
				const { chatId, userId } = data as {
					chatId: string;
					userId: string;
				};
				const timerKey = `${chatId}:${userId}`;
				if (typingTimersRef.current[timerKey] !== undefined) {
					clearTimeout(typingTimersRef.current[timerKey]);
					delete typingTimersRef.current[timerKey];
				}
				setTypingUsers((prev) => {
					const list = (prev[chatId] ?? []).filter((t) => t.userId !== userId);
					if (list.length === 0) {
						// eslint-disable-next-line @typescript-eslint/no-unused-vars
						const { [chatId]: _, ...rest } = prev;
						return rest;
					}
					return { ...prev, [chatId]: list };
				});
			}
		},
		[
			setMessages,
			setChats,
			setThreads,
			setThreadMessages,
			setMessageToThread,
			setTypingUsers,
			typingTimersRef,
		],
	);

	useSse(token, handler);
}

interface EditingMessage {
	chatId: string;
	messageId: string;
	text: string;
	files?: FileInfo[];
	threadId?: string;
}

interface ReplyTarget {
	chatId: string;
	messageId: string;
	fromNick: string;
	text: string;
	files?: FileInfo[];
}

function useSendMessage(opts: {
	activeAccount: { token: string; user: { id: string; nick: string } } | null;
	inputText: string;
	setInputText: (v: string) => void;
	setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>;
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
	pendingChatWith: string | null;
	setPendingChatWith: (v: string | null) => void;
	setPendingChatNick: (v: string | null) => void;
	setActiveChatId: (v: string | null) => void;
	activeChatId: string | null;
	editingMessage: EditingMessage | null;
	setEditingMessage: (v: EditingMessage | null) => void;
	sendingRef: React.MutableRefObject<boolean>;
	replyToMessage: ReplyTarget | null;
	setReplyToMessage: (v: ReplyTarget | null) => void;
	pendingFiles: PendingFile[];
	setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
}) {
	const {
		activeAccount,
		inputText,
		setInputText,
		setMessages,
		setChats,
		pendingChatWith,
		setPendingChatWith,
		setPendingChatNick,
		setActiveChatId,
		activeChatId: activeChatId2,
		editingMessage,
		setEditingMessage,
		sendingRef,
		replyToMessage,
		setReplyToMessage,
		pendingFiles,
		setPendingFiles,
	} = opts;
	return async function handleSend(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (activeAccount === null) return;
		if (inputText.trim().length === 0 && pendingFiles.length === 0) return;
		if (sendingRef.current) return;

		sendingRef.current = true;
		const text = inputText;
		const msgId = crypto.randomUUID();
		const replyToId = replyToMessage?.messageId;
		const filesToUpload = pendingFiles;
		setInputText("");
		setReplyToMessage(null);
		setPendingFiles([]);

		try {
			let fileIDs: string[] = [];
			if (filesToUpload.length > 0) {
				fileIDs = [];
				for (const pf of filesToUpload) {
					const { file: uploaded } = await uploadFile(
						activeAccount.token,
						pf.file,
					);
					fileIDs.push(uploaded.id);
					URL.revokeObjectURL(pf.blobUrl);
				}
			}

			if (editingMessage !== null) {
				const existingIDs = (editingMessage.files ?? []).map((f) => f.id);
				const finalFileIDs = [...existingIDs, ...fileIDs];
				if (editingMessage.threadId !== undefined) {
					await editThreadMessage(
						activeAccount.token,
						editingMessage.chatId,
						editingMessage.threadId,
						editingMessage.messageId,
						text,
						finalFileIDs,
					);
				} else {
					await editMessage(
						activeAccount.token,
						editingMessage.chatId,
						editingMessage.messageId,
						text,
						finalFileIDs,
					);
				}
				setEditingMessage(null);
			} else if (pendingChatWith !== null) {
				const { chat } = await createChat(activeAccount.token, pendingChatWith);
				setChats((prev) =>
					prev.some((c) => c.id === chat.id) ? prev : [...prev, chat],
				);
				setActiveChatId(chat.id);
				setPendingChatWith(null);
				setPendingChatNick(null);

				const pending: Message = {
					id: msgId,
					chatId: chat.id,
					fromId: activeAccount.user.id,
					fromNick: activeAccount.user.nick,
					text,
					createdAt: new Date().toISOString(),
					status: "sending",
				};
				setMessages((prev) => ({
					...prev,
					[chat.id]: [...(prev[chat.id] ?? []), pending],
				}));

				await sendMessage(
					activeAccount.token,
					chat.id,
					text,
					msgId,
					replyToId,
					fileIDs,
				);
				setMessages((prev) => ({
					...prev,
					[chat.id]: prev[chat.id].map((m) =>
						m.id === msgId ? { ...m, status: undefined } : m,
					),
				}));
			} else if (activeChatId2 !== null) {
				const pending: Message = {
					id: msgId,
					chatId: activeChatId2,
					fromId: activeAccount.user.id,
					fromNick: activeAccount.user.nick,
					text,
					createdAt: new Date().toISOString(),
					status: "sending",
				};
				setMessages((prev) => ({
					...prev,
					[activeChatId2]: [...(prev[activeChatId2] ?? []), pending],
				}));

				await sendMessage(
					activeAccount.token,
					activeChatId2,
					text,
					msgId,
					replyToId,
					fileIDs,
				);
				setMessages((prev) => ({
					...prev,
					[activeChatId2]: prev[activeChatId2].map((m) =>
						m.id === msgId ? { ...m, status: undefined } : m,
					),
				}));
			}
		} catch {
			setInputText(text);
			setReplyToMessage(replyToMessage);
			for (const pf of filesToUpload) {
				URL.revokeObjectURL(pf.blobUrl);
			}
			emitNotification(i18n.t("error.send"));
		} finally {
			sendingRef.current = false;
		}
	};
}

export interface ChatInteraction {
	searchQuery: string;
	searchResults: User[];
	inputText: string;
	pendingChatWith: string | null;
	pendingChatNick: string | null;
	showSearchResults: boolean;
	setInputText: (v: string) => void;
	handleSearchChange: (value: string) => void;
	selectPendingChat: (withUserId: string, withUserNick: string) => void;
	selectChat: (chatId: string) => void;
	handleSend: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
	replyToMessage: ReplyTarget | null;
	handleReply: (chatId: string, messageId: string) => void;
	cancelReply: () => void;
	pendingFiles: PendingFile[];
	setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
	handleAttachFiles: (files: File[]) => void;
	handleRemoveFile: (fileId: string) => void;
}

function useChatInteraction(opts: {
	activeAccount: { token: string; user: { id: string; nick: string } } | null;
	setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>;
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
	activeChatId: string | null;
	setActiveChatId: (v: string | null) => void;
	messagesRef: React.MutableRefObject<Record<string, Message[]>>;
	editingMessage: EditingMessage | null;
	setEditingMessage: (v: EditingMessage | null) => void;
	nextCursorsRef: React.MutableRefObject<Record<string, string | null>>;
	setHasMoreMap: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
	setThreads: React.Dispatch<React.SetStateAction<Record<string, Thread>>>;
	setMessageToThread: React.Dispatch<
		React.SetStateAction<Record<string, string>>
	>;
}): ChatInteraction {
	const {
		activeAccount,
		setMessages,
		setChats,
		activeChatId,
		setActiveChatId,
		messagesRef,
		editingMessage,
		setEditingMessage,
		nextCursorsRef,
		setHasMoreMap,
		setThreads,
		setMessageToThread,
	} = opts;
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<User[]>([]);
	const [inputText, setInputText] = useState("");
	const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
	const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);
	const [replyToMessage, setReplyToMessage] = useState<ReplyTarget | null>(
		null,
	);
	const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
	const sendingRef = useRef(false);

	useSearch(activeAccount?.token, searchQuery, setSearchResults);

	function selectChat(chatId: string) {
		if (activeAccount === null) return;
		setPendingChatWith(null);
		setPendingChatNick(null);
		setReplyToMessage(null);
		setActiveChatId(chatId);
		if (messagesRef.current[chatId] === undefined) {
			getMessages(activeAccount.token, chatId, 30)
				.then(({ messages: msgs, nextCursor }) => {
					messagesRef.current[chatId] = msgs;
					setMessages((prev) => ({ ...prev, [chatId]: msgs }));
					const nxt = nextCursor;
					nextCursorsRef.current[chatId] =
						nxt != null && nxt !== "" ? nxt : null;
					setHasMoreMap((prev) => ({
						...prev,
						[chatId]: nxt != null && nxt !== "",
					}));
				})
				.catch(() => {
					emitNotification(i18n.t("error.loadMessages"));
				});
		}
		apiGetThreads(activeAccount.token, chatId)
			.then(({ threads: ts }) => {
				const threadMap: Record<string, Thread> = {};
				const msgToThread: Record<string, string> = {};
				for (const t of ts) {
					threadMap[t.id] = t;
					msgToThread[t.parentMessageId] = t.id;
				}
				setThreads((prev) => ({ ...prev, ...threadMap }));
				setMessageToThread((prev) => ({ ...prev, ...msgToThread }));
			})
			.catch(() => {
				/* ignore */
			});
	}

	function selectPendingChat(withUserId: string, withUserNick: string) {
		setPendingChatWith(withUserId);
		setPendingChatNick(withUserNick);
		setActiveChatId(null);
		setSearchQuery("");
		setSearchResults([]);
		setReplyToMessage(null);
	}

	function handleAttachFiles(files: File[]) {
		for (const file of files) {
			const fileType = file.type.startsWith("image/")
				? "photo"
				: file.type.startsWith("video/")
					? "video"
					: file.type.startsWith("audio/")
						? "audio"
						: "file";
			setPendingFiles((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					file,
					blobUrl: URL.createObjectURL(file),
					originalName: file.name,
					size: file.size,
					mimeType: file.type,
					fileType,
				},
			]);
		}
	}

	function handleRemoveFile(fileId: string) {
		setPendingFiles((prev) => {
			const removed = prev.find((f) => f.id === fileId);
			if (removed) URL.revokeObjectURL(removed.blobUrl);
			return prev.filter((f) => f.id !== fileId);
		});
	}

	const handleSend = useSendMessage({
		activeAccount: activeAccount as {
			token: string;
			user: { id: string; nick: string };
		} | null,
		inputText,
		setInputText,
		setMessages,
		setChats,
		pendingChatWith,
		setPendingChatWith,
		setPendingChatNick,
		setActiveChatId,
		activeChatId,
		editingMessage,
		setEditingMessage,
		sendingRef,
		replyToMessage,
		setReplyToMessage,
		pendingFiles,
		setPendingFiles,
	});

	function handleReply(chatId: string, messageId: string) {
		const msgs = messagesRef.current[chatId];
		if (msgs === undefined) return;
		const msg = msgs.find((m) => m.id === messageId);
		if (msg === undefined) return;
		setReplyToMessage({
			chatId,
			messageId,
			fromNick: msg.fromNick,
			text: msg.text,
			files: msg.files,
		});
	}

	function cancelReply() {
		setReplyToMessage(null);
	}

	function handleSearchChange(value: string) {
		setSearchQuery(value);
		if (value.length === 0) setSearchResults([]);
	}

	const showSearchResults = searchQuery.length > 0 && searchResults.length > 0;

	return {
		searchQuery,
		searchResults,
		inputText,
		pendingChatWith,
		pendingChatNick,
		showSearchResults,
		setInputText,
		handleSearchChange,
		selectPendingChat,
		selectChat,
		handleSend,
		replyToMessage,
		handleReply,
		cancelReply,
		pendingFiles,
		setPendingFiles,
		handleAttachFiles,
		handleRemoveFile,
	};
}

export type ChatPageState = ReturnType<typeof useChatPage>;

export function useChatPage() {
	const navigate = useNavigate();
	const { activeAccount, accounts, logout } = useAuth();
	const [switcherOpen, setSwitcherOpen] = useState(false);

	const [chats, setChats] = useState<Chat[]>([]);
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const [messages, setMessages] = useState<Record<string, Message[]>>({});
	const [config, setConfig] = useState<AppConfig | null>(null);
	const [editingMessage, setEditingMessage] = useState<EditingMessage | null>(
		null,
	);
	const messagesRef = useRef<Record<string, Message[]>>({});
	const nextCursorsRef = useRef<Record<string, string | null>>({});
	const loadingMoreRef = useRef(false);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [hasMoreMap, setHasMoreMap] = useState<Record<string, boolean>>({});

	const [threads, setThreads] = useState<Record<string, Thread>>({});
	const [threadMessages, setThreadMessages] = useState<
		Record<string, Message[]>
	>({});
	const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
	const [messageToThread, setMessageToThread] = useState<
		Record<string, string>
	>({});
	const threadMessagesRef = useRef<Record<string, Message[]>>({});
	const threadNextCursorsRef = useRef<Record<string, string | null>>({});
	const threadLoadingMoreRef = useRef(false);
	const threadSendingRef = useRef(false);
	const [threadIsLoadingMore, setThreadIsLoadingMore] = useState(false);
	const [threadHasMore, setThreadHasMore] = useState(false);

	const [typingUsers, setTypingUsers] = useState<
		Record<string, TypingPayload[]>
	>({});
	const typingTimersRef = useRef<Record<string, number>>({});
	const lastTypingSent = useRef<Record<string, number>>({});

	const user =
		activeAccount !== null
			? { id: activeAccount.user.id, nick: activeAccount.user.nick }
			: null;

	const token = activeAccount?.token;

	useAuthGuard();
	useTokenChange(
		token,
		setChats,
		setMessages,
		messagesRef,
		nextCursorsRef,
		setHasMoreMap,
	);
	useSseMessages(
		token ?? "",
		setChats,
		setMessages,
		setThreads,
		setThreadMessages,
		setMessageToThread,
		setTypingUsers,
		typingTimersRef,
	);

	const handleTyping = useCallback(
		(chatId: string, active: boolean) => {
			if (token === undefined || token === "") return;
			if (active) {
				const now = Date.now();
				const last = lastTypingSent.current[chatId] ?? 0;
				if (now - last < 2000) return;
				lastTypingSent.current[chatId] = now;
			}
			sendTyping(token, chatId, active).catch(() => {
				/* ignore */
			});
		},
		[token],
	);

	useEffect(() => {
		getConfig()
			.then(setConfig)
			.catch(() => {
				emitNotification(i18n.t("error.loadConfig"));
			});
	}, []);

	const interaction = useChatInteraction({
		activeAccount,
		setMessages,
		setChats,
		activeChatId,
		setActiveChatId,
		messagesRef,
		editingMessage,
		setEditingMessage,
		nextCursorsRef,
		setHasMoreMap,
		setThreads,
		setMessageToThread,
	});

	const handleDeleteMessage = useCallback(
		(chatId: string, messageId: string) => {
			if (activeAccount === null) return;

			// Thread message
			if (activeThreadId !== null) {
				const msg = threadMessagesRef.current[activeThreadId]?.find(
					(m) => m.id === messageId,
				);
				if (msg?.status === "sending" || msg?.status === "failed") {
					setThreadMessages((prev) => ({
						...prev,
						[activeThreadId]: (prev[activeThreadId] ?? []).filter(
							(m) => m.id !== messageId,
						),
					}));
					return;
				}
				deleteMessage(activeAccount.token, chatId, messageId).catch(() => {
					emitNotification(i18n.t("error.delete"));
				});
				return;
			}

			// Regular message
			const msg = messagesRef.current[chatId]?.find((m) => m.id === messageId);
			if (msg?.status === "sending" || msg?.status === "failed") {
				setMessages((prev) => ({
					...prev,
					[chatId]: (prev[chatId] ?? []).filter((m) => m.id !== messageId),
				}));
				return;
			}
			deleteMessage(activeAccount.token, chatId, messageId).catch(() => {
				emitNotification(i18n.t("error.delete"));
			});
		},
		[activeAccount, activeThreadId],
	);

	const handleRetryMessage = useCallback(
		(chatId: string, messageId: string) => {
			if (activeAccount === null) return;
			const msg = messagesRef.current[chatId]?.find((m) => m.id === messageId);
			if (!msg || msg.status !== "failed") return;

			setMessages((prev) => ({
				...prev,
				[chatId]: prev[chatId].map((m) =>
					m.id === messageId ? { ...m, status: "sending" as const } : m,
				),
			}));

			sendMessage(activeAccount.token, chatId, msg.text, msg.id)
				.then(() => {
					setMessages((prev) => ({
						...prev,
						[chatId]: prev[chatId].map((m) =>
							m.id === messageId ? { ...m, status: undefined } : m,
						),
					}));
				})
				.catch(() => {
					setMessages((prev) => ({
						...prev,
						[chatId]: prev[chatId].map((m) =>
							m.id === messageId ? { ...m, status: "failed" as const } : m,
						),
					}));
					emitNotification(i18n.t("error.send"));
				});
		},
		[activeAccount],
	);

	const handleRetryThreadMessage = useCallback(
		(threadId: string, messageId: string) => {
			if (activeAccount === null) return;
			const msg = threadMessagesRef.current[threadId]?.find(
				(m) => m.id === messageId,
			);
			if (!msg || msg.status !== "failed") return;

			setThreadMessages((prev) => ({
				...prev,
				[threadId]: (prev[threadId] ?? []).map((m) =>
					m.id === messageId ? { ...m, status: "sending" as const } : m,
				),
			}));

			const thread = threads[threadId];
			if (!thread) {
				return;
			}

			apiSendThreadMessage(
				activeAccount.token,
				thread.chatId,
				threadId,
				msg.text,
				msg.id,
			)
				.then(() => {
					setThreadMessages((prev) => ({
						...prev,
						[threadId]: (prev[threadId] ?? []).map((m) =>
							m.id === messageId ? { ...m, status: undefined } : m,
						),
					}));
				})
				.catch(() => {
					setThreadMessages((prev) => ({
						...prev,
						[threadId]: (prev[threadId] ?? []).map((m) =>
							m.id === messageId ? { ...m, status: "failed" as const } : m,
						),
					}));
					emitNotification(i18n.t("error.send"));
				});
		},
		[activeAccount, threads],
	);

	const handleStartEdit = useCallback(
		(
			chatId: string,
			messageId: string,
			text: string,
			files?: FileInfo[],
			threadId?: string,
		) => {
			setEditingMessage({ chatId, messageId, text, files, threadId });
			interaction.setInputText(text);
		},
		[interaction.setInputText],
	);

	const handleCancelEdit = useCallback(() => {
		setEditingMessage(null);
		interaction.setInputText("");
		interaction.setPendingFiles([]);
	}, [interaction.setInputText, interaction.setPendingFiles]);

	const handleRemoveExistingFile = useCallback((fileId: string) => {
		setEditingMessage((prev) => {
			if (prev === null || prev.files === undefined) return prev;
			return { ...prev, files: prev.files.filter((f) => f.id !== fileId) };
		});
	}, []);

	const loadMoreMessages = useCallback(
		async (chatId: string | null) => {
			if (chatId === null || activeAccount === null) return;
			if (loadingMoreRef.current) return;

			const cursor = nextCursorsRef.current[chatId];
			if (cursor == null) return;

			loadingMoreRef.current = true;
			setIsLoadingMore(true);

			try {
				const res = await getMessages(activeAccount.token, chatId, 30, cursor);
				const existing = messagesRef.current[chatId] ?? [];
				messagesRef.current[chatId] = [...res.messages, ...existing];
				setMessages((prev) => ({
					...prev,
					[chatId]: messagesRef.current[chatId],
				}));
				const nxt = res.nextCursor;
				nextCursorsRef.current[chatId] = nxt != null && nxt !== "" ? nxt : null;
				setHasMoreMap((prev) => ({
					...prev,
					[chatId]: nxt != null && nxt !== "",
				}));
			} catch {
				emitNotification(i18n.t("error.loadMessages"));
			} finally {
				setIsLoadingMore(false);
				loadingMoreRef.current = false;
			}
		},
		[activeAccount],
	);

	const handleCreateThread = useCallback(
		async (chatId: string, messageId: string) => {
			if (activeAccount === null) return;
			try {
				const { thread } = await apiCreateThread(
					activeAccount.token,
					chatId,
					messageId,
				);
				setThreads((prev) => ({ ...prev, [thread.id]: thread }));
				setMessageToThread((prev) => ({
					...prev,
					[thread.parentMessageId]: thread.id,
				}));
				setActiveThreadId(thread.id);
			} catch {
				try {
					const { threads: ts } = await apiGetThreads(
						activeAccount.token,
						chatId,
					);
					const existing = ts.find((t) => t.parentMessageId === messageId);
					if (existing !== undefined) {
						setThreads((prev) => ({ ...prev, [existing.id]: existing }));
						setMessageToThread((prev) => ({
							...prev,
							[messageId]: existing.id,
						}));
						setActiveThreadId(existing.id);
						return;
					}
				} catch {
					/* ignore */
				}
				emitNotification(i18n.t("error.createThread"));
			}
		},
		[activeAccount],
	);

	const handleOpenThread = useCallback((threadId: string) => {
		setActiveThreadId(threadId);
	}, []);

	const handleCloseThread = useCallback(() => {
		setActiveThreadId(null);
	}, []);

	const loadMoreThreadMessages = useCallback(async () => {
		if (activeThreadId === null || activeAccount === null) return;
		if (threadLoadingMoreRef.current) return;

		const cursor = threadNextCursorsRef.current[activeThreadId];
		if (cursor == null) return;

		threadLoadingMoreRef.current = true;
		setThreadIsLoadingMore(true);

		try {
			const thread = threads[activeThreadId];
			if (thread === undefined) return;

			const res = await apiGetThreadMessages(
				activeAccount.token,
				thread.chatId,
				activeThreadId,
				30,
				cursor,
			);
			const existing = threadMessagesRef.current[activeThreadId] ?? [];
			threadMessagesRef.current[activeThreadId] = [
				...res.messages,
				...existing,
			];
			setThreadMessages((prev) => ({
				...prev,
				[activeThreadId]: threadMessagesRef.current[activeThreadId],
			}));
			const nxt = res.nextCursor;
			threadNextCursorsRef.current[activeThreadId] =
				nxt != null && nxt !== "" ? nxt : null;
			setThreadHasMore(nxt != null && nxt !== "");
		} catch {
			emitNotification(i18n.t("error.loadMessages"));
		} finally {
			setThreadIsLoadingMore(false);
			threadLoadingMoreRef.current = false;
		}
	}, [activeThreadId, activeAccount, threads]);

	const handleSendThreadMessage = useCallback(
		async (e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (activeAccount === null || activeThreadId === null) return;
			if (
				interaction.inputText.trim().length === 0 &&
				interaction.pendingFiles.length === 0 &&
				(editingMessage?.files?.length ?? 0) === 0
			)
				return;
			if (threadSendingRef.current) return;

			threadSendingRef.current = true;
			const text = interaction.inputText;
			const msgId = crypto.randomUUID();
			const replyToId = interaction.replyToMessage?.messageId;
			const filesToUpload = interaction.pendingFiles;
			const isEditing =
				editingMessage !== null && editingMessage.threadId !== undefined;
			interaction.setInputText("");
			interaction.cancelReply();
			interaction.setPendingFiles([]);

			const thread = threads[activeThreadId];
			if (thread === undefined) {
				interaction.setInputText(text);
				for (const pf of filesToUpload) {
					URL.revokeObjectURL(pf.blobUrl);
				}
				threadSendingRef.current = false;
				return;
			}

			let fileIDs: string[] = [];
			try {
				if (filesToUpload.length > 0) {
					fileIDs = [];
					for (const pf of filesToUpload) {
						const { file: uploaded } = await uploadFile(
							activeAccount.token,
							pf.file,
						);
						fileIDs.push(uploaded.id);
						URL.revokeObjectURL(pf.blobUrl);
					}
				}

				if (isEditing) {
					const existingIDs = (editingMessage.files ?? []).map((f) => f.id);
					const finalFileIDs = [...existingIDs, ...fileIDs];
					await editThreadMessage(
						activeAccount.token,
						thread.chatId,
						activeThreadId,
						editingMessage.messageId,
						text,
						finalFileIDs,
					);
					setEditingMessage(null);
				} else {
					const pending: Message = {
						id: msgId,
						chatId: thread.chatId,
						fromId: activeAccount.user.id,
						fromNick: activeAccount.user.nick,
						text,
						createdAt: new Date().toISOString(),
						status: "sending",
					};
					setThreadMessages((prev) => ({
						...prev,
						[activeThreadId]: [...(prev[activeThreadId] ?? []), pending],
					}));

					await apiSendThreadMessage(
						activeAccount.token,
						thread.chatId,
						activeThreadId,
						text,
						msgId,
						replyToId,
						fileIDs,
					);
					setThreadMessages((prev) => ({
						...prev,
						[activeThreadId]: (prev[activeThreadId] ?? []).map((m) =>
							m.id === msgId ? { ...m, status: undefined } : m,
						),
					}));
				}
			} catch {
				if (!isEditing) {
					setThreadMessages((prev) => ({
						...prev,
						[activeThreadId]: (prev[activeThreadId] ?? []).map((m) =>
							m.id === msgId ? { ...m, status: "failed" as const } : m,
						),
					}));
				}
				interaction.setInputText(text);
				for (const pf of filesToUpload) {
					URL.revokeObjectURL(pf.blobUrl);
				}
				emitNotification(i18n.t("error.send"));
			} finally {
				threadSendingRef.current = false;
			}
		},
		[activeAccount, activeThreadId, threads, interaction, editingMessage],
	);

	useEffect(() => {
		if (activeThreadId === null || activeAccount === null) return;
		if (threadMessagesRef.current[activeThreadId] !== undefined) return;

		const thread = threads[activeThreadId];
		if (thread === undefined) return;

		apiGetThreadMessages(activeAccount.token, thread.chatId, activeThreadId, 30)
			.then(({ messages: msgs, nextCursor }) => {
				threadMessagesRef.current[activeThreadId] = msgs;
				setThreadMessages((prev) => ({ ...prev, [activeThreadId]: msgs }));
				const nxt = nextCursor;
				threadNextCursorsRef.current[activeThreadId] =
					nxt != null && nxt !== "" ? nxt : null;
				setThreadHasMore(nxt != null && nxt !== "");
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadMessages"));
			});
	}, [activeThreadId, activeAccount, threads]);

	const activeChat =
		interaction.pendingChatWith !== null
			? undefined
			: chats.find((c) => c.id === activeChatId);

	const activeMessages =
		activeChatId !== null ? (messages[activeChatId] ?? []) : [];

	const hasMore = activeChatId !== null && (hasMoreMap[activeChatId] ?? false);

	const activeThread =
		activeThreadId !== null ? (threads[activeThreadId] ?? null) : null;

	const activeThreadMessages =
		activeThreadId !== null ? (threadMessages[activeThreadId] ?? []) : [];

	return {
		activeAccount,
		user,
		accounts,
		chats,
		switcherOpen,
		activeChatId,
		activeChat,
		activeMessages,
		config,
		editingMessage,
		navigate,
		logout,
		handleDeleteMessage,
		handleRetryMessage,
		handleRetryThreadMessage,
		handleStartEdit,
		handleCancelEdit,
		handleRemoveExistingFile,
		setSwitcherOpen,
		isLoadingMore,
		hasMore,
		loadMoreMessages,
		threads,
		messageToThread,
		activeThreadId,
		activeThread,
		activeThreadMessages,
		threadIsLoadingMore,
		threadHasMore,
		handleCreateThread,
		handleOpenThread,
		handleCloseThread,
		loadMoreThreadMessages,
		handleSendThreadMessage,
		typingUsers,
		handleTyping,
		...interaction,
	};
}
