import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig, Chat, Message, User } from "../api.ts";
import {
	createChat,
	deleteMessage,
	editMessage,
	getChats,
	getConfig,
	getMessages,
	searchUsers,
	sendMessage,
} from "../api.ts";
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
) {
	useEffect(() => {
		if (token === undefined || token === "") {
			return;
		}

		messagesRef.current = {};
		setMessages({});
		getChats(token)
			.then(({ chats: fetchedChats }) => {
				setChats(fetchedChats);
			})
			.catch(() => {
				emitNotification("Failed to load chats");
			});
	}, [token, setChats, setMessages, messagesRef]);
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
					emitNotification("Search failed");
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
		};
	}, [query, token, setResults]);
}

function useSseMessages(
	token: string,
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>,
	setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>,
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

				setMessages((prev) => ({
					...prev,
					[msg.chatId]: [...(prev[msg.chatId] ?? []), msg],
				}));
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
			}
		},
		[setMessages, setChats],
	);

	useSse(token, handler);
}

interface EditingMessage {
	chatId: string;
	messageId: string;
	text: string;
}

function useSendMessage(opts: {
	activeAccount: { token: string } | null;
	inputText: string;
	setInputText: (v: string) => void;
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
	pendingChatWith: string | null;
	setPendingChatWith: (v: string | null) => void;
	setPendingChatNick: (v: string | null) => void;
	setActiveChatId: (v: string | null) => void;
	activeChatId: string | null;
	editingMessage: EditingMessage | null;
	setEditingMessage: (v: EditingMessage | null) => void;
}) {
	const {
		activeAccount,
		inputText,
		setInputText,
		setChats,
		pendingChatWith,
		setPendingChatWith,
		setPendingChatNick,
		setActiveChatId,
		activeChatId: activeChatId2,
		editingMessage,
		setEditingMessage,
	} = opts;
	return async function handleSend(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (activeAccount === null || inputText.trim().length === 0) return;

		const text = inputText;
		setInputText("");

		try {
			if (editingMessage !== null) {
				await editMessage(
					activeAccount.token,
					editingMessage.chatId,
					editingMessage.messageId,
					text,
				);
				setEditingMessage(null);
			} else if (pendingChatWith !== null) {
				const { chat } = await createChat(activeAccount.token, pendingChatWith);
				setChats((prev) =>
					prev.some((c) => c.id === chat.id) ? prev : [...prev, chat],
				);
				setActiveChatId(chat.id);
				setPendingChatWith(null);
				setPendingChatNick(null);
				await sendMessage(activeAccount.token, chat.id, text);
			} else if (activeChatId2 !== null) {
				await sendMessage(activeAccount.token, activeChatId2, text);
			}
		} catch {
			setInputText(text);
			emitNotification("Failed to send message");
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
}

function useChatInteraction(opts: {
	activeAccount: { token: string } | null;
	setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>;
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
	activeChatId: string | null;
	setActiveChatId: (v: string | null) => void;
	messagesRef: React.MutableRefObject<Record<string, Message[]>>;
	editingMessage: EditingMessage | null;
	setEditingMessage: (v: EditingMessage | null) => void;
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
	} = opts;
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<User[]>([]);
	const [inputText, setInputText] = useState("");
	const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
	const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);

	useSearch(activeAccount?.token, searchQuery, setSearchResults);

	function selectChat(chatId: string) {
		if (activeAccount === null) return;
		setPendingChatWith(null);
		setPendingChatNick(null);
		setActiveChatId(chatId);
		if (messagesRef.current[chatId] === undefined) {
			getMessages(activeAccount.token, chatId)
				.then(({ messages: msgs }) => {
					messagesRef.current[chatId] = msgs;
					setMessages((prev) => ({ ...prev, [chatId]: msgs }));
				})
				.catch(() => {
					emitNotification("Failed to load messages");
				});
		}
	}

	function selectPendingChat(withUserId: string, withUserNick: string) {
		setPendingChatWith(withUserId);
		setPendingChatNick(withUserNick);
		setActiveChatId(null);
		setSearchQuery("");
		setSearchResults([]);
	}

	const handleSend = useSendMessage({
		activeAccount,
		inputText,
		setInputText,
		setChats,
		pendingChatWith,
		setPendingChatWith,
		setPendingChatNick,
		setActiveChatId,
		activeChatId,
		editingMessage,
		setEditingMessage,
	});

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

	const user =
		activeAccount !== null
			? { id: activeAccount.user.id, nick: activeAccount.user.nick }
			: null;

	const token = activeAccount?.token;

	useAuthGuard();
	useTokenChange(token, setChats, setMessages, messagesRef);
	useSseMessages(token ?? "", setChats, setMessages);

	useEffect(() => {
		getConfig()
			.then(setConfig)
			.catch(() => {
				emitNotification("Failed to load config");
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
	});

	const handleDeleteMessage = useCallback(
		(chatId: string, messageId: string) => {
			if (activeAccount === null) return;
			deleteMessage(activeAccount.token, chatId, messageId).catch(() => {
				emitNotification("Failed to delete message");
			});
		},
		[activeAccount],
	);

	const handleStartEdit = useCallback(
		(chatId: string, messageId: string, text: string) => {
			setEditingMessage({ chatId, messageId, text });
			interaction.setInputText(text);
		},
		[interaction.setInputText],
	);

	const handleCancelEdit = useCallback(() => {
		setEditingMessage(null);
		interaction.setInputText("");
	}, [interaction.setInputText]);

	const activeChat =
		interaction.pendingChatWith !== null
			? undefined
			: chats.find((c) => c.id === activeChatId);

	const activeMessages =
		activeChatId !== null ? (messages[activeChatId] ?? []) : [];

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
		handleStartEdit,
		handleCancelEdit,
		setSwitcherOpen,
		...interaction,
	};
}
