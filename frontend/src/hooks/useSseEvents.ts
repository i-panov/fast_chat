import { useCallback } from "react";
import type { Chat, Message, Thread, TypingPayload } from "../api.ts";
import { useSse } from "../useSse.ts";

interface UseSseEventsParams {
	token: string;
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
	setMessagesMap: React.Dispatch<
		React.SetStateAction<Record<string, Message[]>>
	>;
	setThreadsMap: React.Dispatch<React.SetStateAction<Record<string, Thread>>>;
	setThreadMessagesMap: React.Dispatch<
		React.SetStateAction<Record<string, Message[]>>
	>;
	setMessageToThreadMap: React.Dispatch<
		React.SetStateAction<Record<string, string>>
	>;
	addTypingUser: (payload: TypingPayload) => void;
	clearTyping: (chatId: string, userId: string) => void;
	onSseClosed?: () => void;
}

export function useSseEvents({
	token,
	setChats,
	setMessagesMap,
	setThreadsMap,
	setThreadMessagesMap,
	setMessageToThreadMap,
	addTypingUser,
	clearTyping,
	onSseClosed,
}: UseSseEventsParams) {
	const handler = useCallback(
		(event: string, data: unknown) => {
			if (event === "new_message") {
				const msg = data as Message;
				setMessagesMap((prev) => {
					const list = prev[msg.chatId] ?? [];
					const idx = list.findIndex((m) => m.id === msg.id);
					if (idx !== -1) {
						const next = [...list];
						next[idx] = msg;
						return { ...prev, [msg.chatId]: next };
					}
					return { ...prev, [msg.chatId]: [...list, msg] };
				});
			} else if (event === "message_updated") {
				const msg = data as Message;
				setMessagesMap((prev) => {
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
			} else if (event === "chat_updated") {
				const chat = data as Chat;
				setChats((prev) => prev.map((c) => (c.id === chat.id ? chat : c)));
			} else if (event === "chat_deleted") {
				const { chatId } = data as { chatId: string };
				setChats((prev) => prev.filter((c) => c.id !== chatId));
			} else if (event === "chat_member_added") {
				const { chat } = data as { chatId: string; userId: string; chat: Chat };
				setChats((prev) => prev.map((c) => (c.id === chat.id ? chat : c)));
			} else if (event === "chat_member_removed") {
				const { chat } = data as { chatId: string; userId: string; chat: Chat };
				setChats((prev) => prev.map((c) => (c.id === chat.id ? chat : c)));
			} else if (event === "message_deleted") {
				const { chatId, messageId } = data as {
					chatId: string;
					messageId: string;
				};
				setMessagesMap((prev) => ({
					...prev,
					[chatId]: (prev[chatId] ?? []).filter((m) => m.id !== messageId),
				}));
			} else if (event === "thread_created") {
				const thread = data as Thread;
				setThreadsMap((prev) => {
					if (prev[thread.id] !== undefined) return prev;
					return { ...prev, [thread.id]: thread };
				});
				setMessageToThreadMap((prev) => ({
					...prev,
					[thread.parentMessageId]: thread.id,
				}));
			} else if (event === "thread_message_new") {
				const { threadId, message } = data as {
					threadId: string;
					message: Message;
				};
				setThreadMessagesMap((prev) => {
					const list = prev[threadId] ?? [];
					const idx = list.findIndex((m) => m.id === message.id);
					if (idx !== -1) {
						const next = [...list];
						next[idx] = message;
						return { ...prev, [threadId]: next };
					}
					return { ...prev, [threadId]: [...list, message] };
				});
				setThreadsMap((prev) => {
					const t = prev[threadId];
					if (t === undefined) return prev;
					return {
						...prev,
						[threadId]: { ...t, messageCount: t.messageCount + 1 },
					};
				});
			} else if (event === "typing") {
				const payload = data as TypingPayload;
				addTypingUser(payload);
			} else if (event === "typing_stop") {
				const { chatId, userId } = data as {
					chatId: string;
					userId: string;
				};
				clearTyping(chatId, userId);
			} else if (event === "sse_closed") {
				onSseClosed?.();
			}
		},
		[
			setMessagesMap,
			setChats,
			setThreadsMap,
			setThreadMessagesMap,
			setMessageToThreadMap,
			addTypingUser,
			clearTyping,
			onSseClosed,
		],
	);

	useSse(token, handler);
}
