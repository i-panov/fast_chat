import { useCallback, useEffect, useRef } from "react";
import type { CallManager } from "../calls/callManager.ts";
import { handleCallEvent } from "../calls/handleCallEvent.ts";
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
	// callManager receives the signaling events of the call domain. It may be
	// undefined when the calls are not available.
	callManager?: CallManager;
}

// applyReadEvent marks a message as read by a reader. The readers are
// accumulated instead of overwritten, so two readers do not erase each other.
async function applyReadEvent(data: { messageId: string; readerId: string }) {
	const { messageId, readerId } = data;

	const existing = await messagesRepo.getByIdAny(messageId);
	const currentReadBy = existing?.readBy ?? [];
	const newReadBy = currentReadBy.includes(readerId)
		? currentReadBy
		: [...currentReadBy, readerId];
	void messagesRepo.updateDeliveryStatus(messageId, "read", newReadBy);

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
}

// routeCallEvent hands a call event to the manager, if there is one.
function routeCallEvent(
	callManager: CallManager | undefined,
	event: string,
	data: unknown,
): void {
	if (callManager === undefined) return;

	handleCallEvent(callManager, event, data);
}

// isCallEvent reports whether an event belongs to the call domain.
function isCallEvent(event: string): boolean {
	return (
		event === "call_incoming" ||
		event === "call_accepted" ||
		event === "call_ended" ||
		event === "call_ice"
	);
}

// chatFromEvent extracts the chat from an SSE payload. The membership events
// carry it wrapped ("{ chatId, userId, chat }"), the other chat events send
// the chat itself.
function chatFromEvent(data: unknown): Chat | null {
	const payload = data as { chat?: Chat; id?: string } | null;
	if (payload === null || typeof payload !== "object") return null;

	if (payload.chat !== undefined && payload.chat !== null) {
		return payload.chat;
	}

	if (typeof payload.id === "string") {
		return payload as unknown as Chat;
	}

	return null;
}

export function useSseEvents({
	token,
	knownThreadIdsRef,
	addTypingUser,
	clearTyping,
	onTokenExpiring,
	onTokenExpired,
	callManager,
}: UseSseEventsParams) {
	const tokenRef = useRef(token);
	useEffect(() => {
		tokenRef.current = token;
	}, [token]);

	const handler = useCallback(
		async (event: string, data: unknown) => {
			if (isCallEvent(event)) {
				routeCallEvent(callManager, event, data);
				return;
			}
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
				await applyReadEvent(data as { messageId: string; readerId: string });
				return;
			}
			if (
				event === "chat_created" ||
				event === "chat_updated" ||
				event === "chat_member_added" ||
				event === "chat_member_removed"
			) {
				const chat = chatFromEvent(data);
				if (chat !== null) {
					void chatsRepo.upsert(chat);
				}

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
			callManager,
		],
	);

	useSse(token, handler);
}
