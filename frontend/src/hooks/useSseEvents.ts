import { useCallback, useEffect, useRef } from "react";
import type { CallManager } from "../calls/callManager.ts";
import { handleCallEvent } from "../calls/handleCallEvent.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { getDB } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { notify } from "../db/notify.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import type { Chat, Message, Thread, TypingPayload } from "../types/api.ts";
import { useSse } from "../useSse.ts";

interface UseSseEventsParams {
	token: string;
	addTypingUser: (payload: TypingPayload) => void;
	clearTyping: (chatId: string, userId: string) => void;
	onTokenExpiring: (currentToken: string) => Promise<void>;
	onTokenExpired: () => void;
	// callManager receives the signaling events of the call domain. It may be
	// undefined when the calls are not available.
	callManager?: CallManager;
}

// applyReadEvent marks a message as read by a reader. The readers are
// merged inside a single readwrite transaction over both message stores,
// so two concurrent read events re-read and union instead of
// read-modify-write racing and dropping each other.
async function applyReadEvent(data: { messageId: string; readerId: string }) {
	const { messageId, readerId } = data;

	const db = await getDB();
	const tx = db.transaction(["messages", "threadMessages"], "readwrite");

	const existing = await tx.objectStore("messages").get(messageId);
	if (existing !== undefined) {
		const currentReadBy = existing.readBy ?? [];
		const newReadBy = currentReadBy.includes(readerId)
			? currentReadBy
			: [...currentReadBy, readerId];
		await tx.objectStore("messages").put({
			...existing,
			deliveryStatus: "read",
			readBy: newReadBy,
			_updatedAt: new Date().toISOString(),
		});
	}

	const existingThread = await tx.objectStore("threadMessages").get(messageId);
	if (existingThread !== undefined) {
		const currentThreadReadBy = existingThread.readBy ?? [];
		const newThreadReadBy = currentThreadReadBy.includes(readerId)
			? currentThreadReadBy
			: [...currentThreadReadBy, readerId];
		await tx.objectStore("threadMessages").put({
			...existingThread,
			deliveryStatus: "read",
			readBy: newThreadReadBy,
			_updatedAt: new Date().toISOString(),
		});
	}

	await tx.done;
	notify();
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
				// No explicit "sent": upsert without a status keeps a local
				// queued/failed row (with its pending file references) until
				// the outbox finishes, instead of flipping it to sent early.
				await messagesRepo.upsert(msg);
				return;
			}
			if (event === "message_deleted") {
				const { chatId, messageId } = data as {
					chatId: string;
					messageId: string;
				};
				// Route by messageId in both stores like deltaApplier: the
				// chatId of a thread deletion is the real chat, not the
				// thread, so knownThreadIds routing could hit the wrong store.
				// Awaited in order so a preceding new_message lands first.
				await messagesRepo.applyDelete(chatId, messageId);
				const threadMessage = await threadMessagesRepo.getByIdAny(messageId);
				if (threadMessage !== undefined) {
					await threadMessagesRepo.applyDelete(
						threadMessage.threadId,
						messageId,
					);
				}
				return;
			}
			if (event === "message_delivered") {
				const { messageId } = data as { messageId: string };
				await messagesRepo.updateDeliveryStatus(messageId, "delivered");
				await threadMessagesRepo.updateDeliveryStatus(messageId, "delivered");
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
					await chatsRepo.upsert(chat);
				}

				return;
			}
			if (event === "chat_deleted") {
				const { chatId } = data as { chatId: string };
				await chatsRepo.remove(chatId);
				return;
			}
			if (event === "thread_created") {
				const thread = data as Thread;
				await threadsRepo.upsert(thread);
				return;
			}
			if (event === "thread_message_new") {
				const { threadId, message } = data as {
					threadId: string;
					message: Message;
				};
				await threadMessagesRepo.upsert(message, threadId);
				return;
			}
			if (event === "user_status_changed") {
				const { userId, online } = data as {
					userId: string;
					online: boolean;
				};
				await chatsRepo.updateMemberStatus(userId, online);
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
		[addTypingUser, clearTyping, onTokenExpiring, onTokenExpired, callManager],
	);

	useSse(token, handler);
}
