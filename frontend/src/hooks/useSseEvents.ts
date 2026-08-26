import { useCallback, useRef } from "react";
import { chatsRepo } from "../db/chatsRepo.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import type { Chat, Message, Thread, TypingPayload } from "../types/api.ts";
import { useSse } from "../useSse.ts";

interface UseSseEventsParams {
	token: string;
	knownThreadIdsRef: React.MutableRefObject<Set<string>>;
	addTypingUser: (payload: TypingPayload) => void;
	clearTyping: (chatId: string, userId: string) => void;
	onTokenExpiring: (currentToken: string) => Promise<void>;
	onTokenExpired: () => void;
}

export function useSseEvents({
	token,
	knownThreadIdsRef,
	addTypingUser,
	clearTyping,
	onTokenExpiring,
	onTokenExpired,
}: UseSseEventsParams) {
	const tokenRef = useRef(token);
	tokenRef.current = token;

	const handler = useCallback(
		async (event: string, data: unknown) => {
			if (event === "new_message" || event === "message_updated") {
				const msg = data as Message;
				void messagesRepo.upsert(msg, "sent");
				return;
			}
			if (event === "message_deleted") {
				const { chatId, messageId } = data as {
					chatId: string;
					messageId: string;
				};
				if (knownThreadIdsRef.current.has(chatId)) {
					void threadMessagesRepo.applyDelete(chatId, messageId);
				} else {
					void messagesRepo.applyDelete(chatId, messageId);
				}
				return;
			}
			if (event === "message_delivered") {
				const { messageId } = data as { messageId: string };
				void messagesRepo.updateDeliveryStatus(messageId, "delivered");
				void threadMessagesRepo.updateDeliveryStatus(messageId, "delivered");
				return;
			}
			if (event === "message_read") {
				const { messageId, readerId } = data as {
					messageId: string;
					readerId: string;
				};
				// Accumulate readBy list instead of overwriting
				const existing = await messagesRepo.getByIdAny(messageId);
				const currentReadBy = existing?.readBy ?? [];
				const newReadBy = currentReadBy.includes(readerId)
					? currentReadBy
					: [...currentReadBy, readerId];
				void messagesRepo.updateDeliveryStatus(messageId, "read", newReadBy);

				// Same for thread messages
				const existingThread = await threadMessagesRepo.getByIdAny(messageId);
				const currentThreadReadBy = existingThread?.readBy ?? [];
				const newThreadReadBy = currentThreadReadBy.includes(readerId)
					? currentThreadReadBy
					: [...currentThreadReadBy, readerId];
				void threadMessagesRepo.updateDeliveryStatus(
					messageId,
					"read",
					newThreadReadBy,
				);
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
				void threadsRepo.upsert(thread);
				return;
			}
			if (event === "thread_message_new") {
				const { threadId, message } = data as {
					threadId: string;
					message: Message;
				};
				void threadMessagesRepo.upsert(message, threadId, "sent");
				return;
			}
			if (event === "user_status_changed") {
				const { userId, online } = data as {
					userId: string;
					online: boolean;
				};
				void chatsRepo.updateMemberStatus(userId, online);
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
			addTypingUser,
			clearTyping,
			onTokenExpiring,
			onTokenExpired,
			knownThreadIdsRef,
		],
	);

	useSse(token, handler);
}
