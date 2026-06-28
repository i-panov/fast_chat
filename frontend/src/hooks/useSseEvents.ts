import { useCallback, useRef } from "react";
import type { Chat, Message, Thread, TypingPayload } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import { useSse } from "../useSse.ts";

interface UseSseEventsParams {
	token: string;
	setThreadsMap: React.Dispatch<React.SetStateAction<Record<string, Thread>>>;
	setThreadMessagesMap: React.Dispatch<
		React.SetStateAction<Record<string, Message[]>>
	>;
	setMessageToThreadMap: React.Dispatch<
		React.SetStateAction<Record<string, string>>
	>;
	addTypingUser: (payload: TypingPayload) => void;
	clearTyping: (chatId: string, userId: string) => void;
	onTokenExpiring: (currentToken: string) => Promise<void>;
	onTokenExpired: () => void;
}

export function useSseEvents({
	token,
	setThreadsMap,
	setThreadMessagesMap,
	setMessageToThreadMap,
	addTypingUser,
	clearTyping,
	onTokenExpiring,
	onTokenExpired,
}: UseSseEventsParams) {
	const tokenRef = useRef(token);
	tokenRef.current = token;

	const handler = useCallback(
		(event: string, data: unknown) => {
			if (event === "new_message" || event === "message_updated") {
				const msg = data as Message;
				void messagesRepo.upsert(msg);
				return;
			}
			if (event === "message_deleted") {
				const { chatId, messageId } = data as {
					chatId: string;
					messageId: string;
				};
				void messagesRepo.applyDelete(chatId, messageId);
				return;
			}
			if (
				event === "chat_created" ||
				event === "chat_updated" ||
				event === "chat_member_added" ||
				event === "chat_member_removed"
			) {
				const chat = data as Chat;
				void chatsRepo.upsert(chat);
				return;
			}
			if (event === "chat_deleted") {
				const { chatId } = data as { chatId: string };
				void chatsRepo.remove(chatId);
				return;
			}
			if (event === "thread_created") {
				const thread = data as Thread;
				setThreadsMap((prev) => {
					if (prev[thread.id] !== undefined) return prev;
					return { ...prev, [thread.id]: thread };
				});
				setMessageToThreadMap((prev) => ({
					...prev,
					[thread.parentMessageId]: thread.id,
				}));
				return;
			}
			if (event === "thread_message_new") {
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
				return;
			}
			if (event === "typing") {
				const payload = data as TypingPayload;
				addTypingUser(payload);
				return;
			}
			if (event === "typing_stop") {
				const { chatId, userId } = data as {
					chatId: string;
					userId: string;
				};
				clearTyping(chatId, userId);
				return;
			}
			if (event === "token_expiring") {
				void onTokenExpiring(tokenRef.current);
				return;
			}
			if (event === "token_expired") {
				onTokenExpired();
				return;
			}
			if (event === "sse_closed") {
				scheduleSync();
			}
		},
		[
			setThreadsMap,
			setThreadMessagesMap,
			setMessageToThreadMap,
			addTypingUser,
			clearTyping,
			onTokenExpiring,
			onTokenExpired,
		],
	);

	useSse(token, handler);
}
