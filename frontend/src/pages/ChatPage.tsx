import {
	ActionIcon,
	Anchor,
	Badge,
	Button,
	Center,
	Group,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import type { FormEvent } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AccountSwitcher } from "../AccountSwitcher.tsx";
import type { Chat, MemberInfo, Message, User } from "../api.ts";
import {
	createChat,
	deleteMessage,
	getChats,
	getMessages,
	searchUsers,
	sendMessage,
} from "../api.ts";
import { useAuth } from "../useAuth.tsx";
import { useSse } from "../useSse.ts";

const SEARCH_DEBOUNCE_MS = 300;

function otherNick(members: MemberInfo[], myId: string): string {
	return members.find((m) => m.id !== myId)?.nick ?? "Unknown";
}

function formatDateLabel(isoStr: string): string {
	const d = new Date(isoStr);
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	const fmt: Intl.DateTimeFormatOptions = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	};
	const dStr = d.toLocaleDateString("ru-RU", fmt);
	const todayStr = today.toLocaleDateString("ru-RU", fmt);
	const yesterdayStr = yesterday.toLocaleDateString("ru-RU", fmt);

	if (dStr === todayStr) return "Сегодня";
	if (dStr === yesterdayStr) return "Вчера";
	return dStr;
}

function formatTime(isoStr: string): string {
	const d = new Date(isoStr);
	return d.toLocaleTimeString("ru-RU", {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function useAuthGuard(
	activeAccount: unknown,
	navigate: ReturnType<typeof useNavigate>,
) {
	useEffect(() => {
		if (activeAccount === null) {
			navigate({ to: "/login" });
		}
	}, [activeAccount, navigate]);
}

function useTokenChange(
	token: string | undefined,
	setChats: (c: Chat[]) => void,
) {
	useEffect(() => {
		if (token === undefined || token === "") {
			return;
		}
		getChats(token)
			.then(({ chats: fetchedChats }) => {
				setChats(fetchedChats);
			})
			.catch(() => {});
	}, [token, setChats]);
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
				.catch(() => {});
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
	const seenIds = useRef(new Set<string>());

	const handler = useCallback(
		(event: string, data: unknown) => {
			if (event === "new_message") {
				const msg = data as Message;
				if (seenIds.current.has(msg.id)) return;
				seenIds.current.add(msg.id);
				setMessages((prev) => ({
					...prev,
					[msg.chatId]: [...(prev[msg.chatId] ?? []), msg],
				}));
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
	} = opts;
	return async function handleSend(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (activeAccount === null || inputText.trim().length === 0) return;

		const text = inputText;
		setInputText("");

		try {
			if (pendingChatWith !== null) {
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
		}
	};
}

function extractCodeText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(String).join("");
	return String(children);
}

interface ChatInteraction {
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
	handleSend: (e: FormEvent<HTMLFormElement>) => Promise<void>;
}

function useChatInteraction(
	activeAccount: { token: string } | null,
	setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>,
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>,
	activeChatId: string | null,
	setActiveChatId: (v: string | null) => void,
): ChatInteraction {
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<User[]>([]);
	const [inputText, setInputText] = useState("");
	const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
	const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);
	const messagesRef = useRef<Record<string, Message[]>>({});

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
				.catch(() => {});
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

function useChatPage() {
	const navigate = useNavigate();
	const { activeAccount, accounts, logout } = useAuth();
	const [switcherOpen, setSwitcherOpen] = useState(false);

	const [chats, setChats] = useState<Chat[]>([]);
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const [messages, setMessages] = useState<Record<string, Message[]>>({});

	const user =
		activeAccount !== null
			? { id: activeAccount.user.id, nick: activeAccount.user.nick }
			: null;

	const token = activeAccount?.token;

	useAuthGuard(activeAccount, navigate);
	useTokenChange(token, setChats);
	useSseMessages(token ?? "", setChats, setMessages);

	const interaction = useChatInteraction(
		activeAccount,
		setMessages,
		setChats,
		activeChatId,
		setActiveChatId,
	);

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
		logout,
		setSwitcherOpen,
		...interaction,
	};
}

function AppHeader({
	nick,
	accountCount,
	onSwitcherToggle,
	onLogout,
}: {
	nick: string;
	accountCount: number;
	onSwitcherToggle: () => void;
	onLogout: () => void;
}) {
	return (
		<Paper
			component="header"
			className="rounded-none bg-[var(--mantine-color-dark-6)] border-b border-[var(--mantine-color-dark-4)]"
		>
			<Group justify="space-between" px="md" h={48}>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="lg"
					onClick={onSwitcherToggle}
				>
					☰
				</ActionIcon>
				<Text fw={600} size="sm">
					@{nick}
					{accountCount > 1 && (
						<Badge size="xs" variant="filled" ml={4} color="gray">
							+{accountCount - 1}
						</Badge>
					)}
				</Text>
				<Button variant="outline" size="compact-sm" onClick={onLogout}>
					Logout
				</Button>
			</Group>
		</Paper>
	);
}

function SearchBox({
	query,
	results,
	showResults,
	onQueryChange,
	onSelectUser,
}: {
	query: string;
	results: User[];
	showResults: boolean;
	onQueryChange: (value: string) => void;
	onSelectUser: (userId: string, nick: string) => void;
}) {
	return (
		<div className="p-3 border-b border-[var(--mantine-color-dark-4)] relative">
			<TextInput
				placeholder="Search users..."
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
				size="sm"
			/>
			{showResults && (
				<Paper
					className="absolute top-full left-0 right-0 z-10 max-h-50 overflow-y-auto"
					style={{ background: "var(--mantine-color-dark-8)" }}
					withBorder
				>
					{results.map((u) => (
						<Button
							key={u.id}
							variant="subtle"
							color="gray"
							fullWidth
							justify="flex-start"
							className="rounded-none"
							onClick={() => onSelectUser(u.id, u.nick)}
						>
							<Text size="sm">@{u.nick}</Text>
							{u.online && (
								<Text size="xs" c="dimmed" ml={4}>
									(online)
								</Text>
							)}
						</Button>
					))}
				</Paper>
			)}
		</div>
	);
}

function ChatList({
	chats,
	activeChatId,
	userId,
	onSelectChat,
}: {
	chats: Chat[];
	activeChatId: string | null;
	userId: string;
	onSelectChat: (chatId: string) => void;
}) {
	return (
		<ScrollArea className="flex-1">
			{chats.length === 0 && (
				<Text ta="center" c="dimmed" size="sm" py={32}>
					No chats yet. Search for a user above to start one.
				</Text>
			)}
			{chats.map((chat) => (
				<Button
					key={chat.id}
					variant="subtle"
					color="gray"
					fullWidth
					justify="flex-start"
					style={{
						...(chat.id === activeChatId
							? {
									background: "var(--mantine-color-dark-5)",
									borderLeft: "3px solid var(--mantine-color-blue-7)",
								}
							: {}),
					}}
					className="rounded-none border-b border-[var(--mantine-color-dark-4)] h-auto py-2"
					onClick={() => onSelectChat(chat.id)}
				>
					<Text size="sm">@{otherNick(chat.members, userId)}</Text>
				</Button>
			))}
		</ScrollArea>
	);
}

function DateSeparator({ dateStr }: { dateStr: string }) {
	return (
		<Text ta="center" size="xs" c="dimmed" py={6}>
			{formatDateLabel(dateStr)}
		</Text>
	);
}

function CodeBlock({
	className,
	code,
	lang,
}: {
	className?: string;
	code: string;
	lang: string;
}) {
	const [copied, setCopied] = useState(false);

	return (
		<div
			style={{
				maxHeight: "300px",
				overflow: "auto",
				background: "var(--mantine-color-dark-7)",
				borderRadius: "4px",
				marginTop: "4px",
				marginBottom: "2px",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					position: "sticky",
					top: 0,
					background: "var(--mantine-color-dark-6)",
					padding: "2px 8px",
					borderBottom: "1px solid var(--mantine-color-dark-4)",
					zIndex: 1,
				}}
			>
				{lang ? (
					<Text size="xs" c="gray.6">
						{lang}
					</Text>
				) : (
					<div />
				)}
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={() => {
						navigator.clipboard.writeText(code).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						});
					}}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</ActionIcon>
			</div>
			<pre style={{ padding: "8px", margin: 0 }}>
				<code className={className}>{code}</code>
			</pre>
		</div>
	);
}

function MessageBubble({
	text,
	isOwn,
	time,
	chatId,
	msgId,
	onDelete,
}: {
	text: string;
	isOwn: boolean;
	time: string;
	chatId: string;
	msgId: string;
	onDelete: (chatId: string, messageId: string) => void;
}) {
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

	return (
		<>
			<Paper
				className={isOwn ? "bubble-own" : "bubble-other"}
				onContextMenu={(e) => {
					e.preventDefault();
					setMenuPos({ x: e.clientX, y: e.clientY });
				}}
			>
				<Group gap={6} wrap="nowrap" align="end">
					<div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
						<Markdown
							remarkPlugins={[remarkGfm]}
							components={{
								p: ({ children }) => <span>{children}</span>,
								a: ({ href, children }) => (
									<Anchor href={href} target="_blank" rel="noreferrer">
										{children}
									</Anchor>
								),
								code: ({ className, children }) => {
									const lang = className?.replace("language-", "");
									if (lang) {
										return <code className={className}>{children}</code>;
									}
									return (
										<code
											style={{
												background: "var(--mantine-color-dark-7)",
												padding: "1px 4px",
												borderRadius: "3px",
												fontSize: "0.85em",
											}}
										>
											{children}
										</code>
									);
								},
								pre: ({ children }) => {
									const codeEl = children as {
										props: { className?: string; children: unknown };
									};
									const className = codeEl.props.className ?? "";
									const lang = className.replace("language-", "");
									const codeText = extractCodeText(codeEl.props.children);
									return (
										<CodeBlock
											className={className}
											code={codeText}
											lang={lang}
										/>
									);
								},
							}}
						>
							{text}
						</Markdown>
					</div>
					<Text size="xs" c="gray.5" className="shrink-0">
						{time}
					</Text>
				</Group>
			</Paper>
			{menuPos && (
				<>
					<UnstyledButton
						style={{
							position: "fixed",
							inset: 0,
							zIndex: 999,
							cursor: "default",
						}}
						onClick={() => setMenuPos(null)}
						aria-label="Close menu"
					/>
					<Paper
						style={{
							position: "fixed",
							left: menuPos.x,
							top: menuPos.y,
							zIndex: 1000,
							minWidth: "140px",
						}}
					>
						<Stack gap={0}>
							<Button
								variant="subtle"
								color="gray"
								fullWidth
								justify="flex-start"
								className="rounded-none"
								onClick={() => {
									navigator.clipboard.writeText(text);
									setMenuPos(null);
								}}
							>
								Копировать
							</Button>
							{isOwn && (
								<Button
									variant="subtle"
									color="red"
									fullWidth
									justify="flex-start"
									className="rounded-none"
									onClick={() => {
										onDelete(chatId, msgId);
										setMenuPos(null);
									}}
								>
									Удалить
								</Button>
							)}
						</Stack>
					</Paper>
				</>
			)}
		</>
	);
}

function ChatHeader({ title, badge }: { title: string; badge?: string }) {
	return (
		<Paper
			component="header"
			className="px-4 py-3 rounded-none bg-[var(--mantine-color-dark-8)] border-b border-[var(--mantine-color-dark-4)]"
		>
			<Text fw={600}>
				@{title}
				{badge !== undefined && (
					<Badge size="xs" color="gray" ml={8}>
						{badge}
					</Badge>
				)}
			</Text>
		</Paper>
	);
}

function MessageList({
	messages,
	userId,
	onDelete,
}: {
	messages: Message[];
	userId: string;
	onDelete: (chatId: string, messageId: string) => void;
}) {
	if (messages.length === 0) {
		return (
			<Text ta="center" c="dimmed" size="sm" py={32}>
				No messages yet
			</Text>
		);
	}

	const fmt: Intl.DateTimeFormatOptions = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	};
	let lastDateKey = "";

	return (
		<div className="flex flex-col gap-2">
			{messages.map((msg) => {
				const dateKey = new Date(msg.createdAt).toLocaleDateString(
					"ru-RU",
					fmt,
				);
				const showSeparator = dateKey !== lastDateKey;
				lastDateKey = dateKey;

				return (
					<Fragment key={msg.id}>
						{showSeparator && <DateSeparator dateStr={msg.createdAt} />}
						<MessageBubble
							text={msg.text}
							isOwn={msg.fromId === userId}
							time={formatTime(msg.createdAt)}
							chatId={msg.chatId}
							msgId={msg.id}
							onDelete={onDelete}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}

function InputBar({
	text,
	onTextChange,
	onSubmit,
}: {
	text: string;
	onTextChange: (value: string) => void;
	onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
	return (
		<form
			className="flex gap-2 p-3 border-t border-[var(--mantine-color-dark-4)] bg-[var(--mantine-color-dark-8)]"
			onSubmit={onSubmit}
		>
			<Textarea
				placeholder="Type a message..."
				value={text}
				onChange={(e) => onTextChange(e.target.value)}
				className="flex-1"
				size="sm"
				autosize
				minRows={1}
				maxRows={6}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						e.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			<Button type="submit" disabled={text.trim().length === 0} size="sm">
				Send
			</Button>
		</form>
	);
}

export function ChatPage() {
	const s = useChatPage();

	const handleDeleteMessage = useCallback(
		(chatId: string, messageId: string) => {
			if (s.activeAccount === null) return;
			deleteMessage(s.activeAccount.token, chatId, messageId).catch(() => {});
		},
		[s.activeAccount],
	);

	if (s.activeAccount === null || s.user === null) {
		return null;
	}

	return (
		<Stack h="100%" gap={0}>
			<AccountSwitcher
				open={s.switcherOpen}
				onClose={() => s.setSwitcherOpen(false)}
			/>
			<AppHeader
				nick={s.activeAccount.user.nick}
				accountCount={s.accounts.length}
				onSwitcherToggle={() => s.setSwitcherOpen(true)}
				onLogout={s.logout}
			/>
			<div className="flex flex-1 min-h-0">
				<Paper
					component="aside"
					className="w-[300px] min-w-[300px] rounded-none border-r border-[var(--mantine-color-dark-4)] bg-[var(--mantine-color-dark-8)]"
				>
					<Stack h="100%" gap={0}>
						<SearchBox
							query={s.searchQuery}
							results={s.searchResults}
							showResults={s.showSearchResults}
							onQueryChange={s.handleSearchChange}
							onSelectUser={s.selectPendingChat}
						/>
						<ChatList
							chats={s.chats}
							activeChatId={s.activeChatId}
							userId={s.user.id}
							onSelectChat={s.selectChat}
						/>
					</Stack>
				</Paper>
				<Paper
					component="main"
					className="flex-1 min-h-0 rounded-none bg-[var(--mantine-color-dark-9)]"
				>
					<Stack h="100%" gap={0}>
						{s.pendingChatWith !== null ? (
							<>
								<ChatHeader title={s.pendingChatNick ?? ""} badge="New chat" />
								<ScrollArea className="flex-1 p-4">
									<Text ta="center" c="dimmed" size="sm" py={32}>
										Send a message to start a chat with @{s.pendingChatNick}
									</Text>
								</ScrollArea>
								<InputBar
									text={s.inputText}
									onTextChange={s.setInputText}
									onSubmit={s.handleSend}
								/>
							</>
						) : s.activeChat === undefined ? (
							<Center className="flex-1">
								<Text ta="center" c="dimmed" size="sm">
									Select a chat or search for a user to start messaging
								</Text>
							</Center>
						) : (
							<>
								<ChatHeader
									title={otherNick(s.activeChat.members, s.user.id)}
								/>
								<ScrollArea className="flex-1 p-4">
									<MessageList
										messages={s.activeMessages}
										userId={s.user.id}
										onDelete={handleDeleteMessage}
									/>
								</ScrollArea>
								<InputBar
									text={s.inputText}
									onTextChange={s.setInputText}
									onSubmit={s.handleSend}
								/>
							</>
						)}
					</Stack>
				</Paper>
			</div>
		</Stack>
	);
}
