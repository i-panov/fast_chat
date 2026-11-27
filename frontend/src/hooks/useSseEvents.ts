import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef } from "react";
import type { CallManager } from "../calls/callManager.ts";
import { handleCallEvent } from "../calls/handleCallEvent.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { getActiveAccountKey, getDB } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { notify } from "../db/notify.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import {
	getMyKeyPair,
	hasLocalLock,
	isLocalLockUnlocked,
} from "../e2ee/keys.ts";
import { decryptMessageContent } from "../e2ee/message.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import type {
	Chat,
	Message,
	ReactionSummary,
	Thread,
	TypingPayload,
} from "../types/api.ts";
import { useSse } from "../useSse.ts";

interface UseSseEventsParams {
	token: string;
	userId?: string;
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

async function applyReactionsEvent(data: {
	messageId: string;
	reactions: ReactionSummary[];
}) {
	const db = await getDB();
	const tx = db.transaction(["messages", "threadMessages"], "readwrite");
	for (const storeName of ["messages", "threadMessages"] as const) {
		const existing = await tx.objectStore(storeName).get(data.messageId);
		if (existing === undefined) continue;
		await tx.objectStore(storeName).put({
			...existing,
			reactions: data.reactions,
			_updatedAt: new Date().toISOString(),
		});
	}
	await tx.done;
	notify();
}

async function applyChatPinEvent(data: {
	chatId: string;
	messageId: string;
	pinned: boolean;
}) {
	const chat = await chatsRepo.getById(data.chatId);
	if (chat === undefined) return;
	const current = chat.pinnedMessageIds ?? [];
	const ids = data.pinned
		? current.includes(data.messageId)
			? current
			: [data.messageId, ...current]
		: current.filter((id) => id !== data.messageId);
	await chatsRepo.upsert({ ...chat, pinnedMessageIds: ids });
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

// upsertThreadMessage stores a thread message and keeps the thread's counter
// in step. MessageList renders links from threadsRepo only, so without the
// counter update a reply after the first one still shows 0 (or the stale
// count) until the next full getThreads.
async function upsertThreadMessage(
	message: Message,
	threadId: string,
): Promise<void> {
	const existing = await threadMessagesRepo.getByIdAny(message.id);
	await threadMessagesRepo.upsert(message, threadId);
	if (existing !== undefined) return;

	const thread = await threadsRepo.getById(threadId);
	if (thread === undefined) return;
	await threadsRepo.upsert({
		...thread,
		messageCount: (thread.messageCount ?? 0) + 1,
	});
}

async function showBotCallbackAnswer(
	data: unknown,
	userId: string | undefined,
): Promise<void> {
	const answer = data as {
		text?: string;
		showAlert?: boolean;
		encrypted?: boolean;
		encryptedPayload?: string;
		botId?: string;
		chatId?: string;
		messageId?: string;
	};
	if (answer.text === undefined || answer.text === "") return;
	// The local lock hides message content: a notification with the text of
	// an unencrypted bot answer would bypass it.
	if ((await hasLocalLock()) && !isLocalLockUnlocked()) return;
	let text = answer.text;
	if (answer.encrypted === true && answer.encryptedPayload !== undefined) {
		if (
			userId === undefined ||
			answer.botId === undefined ||
			answer.chatId === undefined ||
			answer.messageId === undefined
		) {
			return;
		}
		try {
			const key = await getMyKeyPair();
			if (key === null) return;
			const content = await decryptMessageContent(
				{
					text: answer.text,
					encryptedPayload: answer.encryptedPayload,
					chatId: answer.chatId,
					id: answer.messageId,
					fromId: answer.botId,
				},
				userId,
				key,
			);
			if (content === null) return;
			text = content.text;
		} catch {
			return;
		}
	}
	notifications.show({
		message: text,
		color: answer.showAlert === true ? "red" : "teal",
	});
}

export function useSseEvents({
	token,
	userId,
	addTypingUser,
	clearTyping,
	onTokenExpiring,
	onTokenExpired,
	callManager,
}: UseSseEventsParams) {
	const tokenRef = useRef(token);
	const userIdRef = useRef(userId);
	// The first "connected" belongs to the connection the login already
	// scheduled a sync for; every later one follows a silent EventSource
	// reconnect that delivered nothing, so the gap has to be caught up.
	const connectedRef = useRef(false);
	useEffect(() => {
		tokenRef.current = token;
		connectedRef.current = false;
	}, [token]);
	useEffect(() => {
		userIdRef.current = userId;
	}, [userId]);

	const handler = useCallback(
		// eslint-disable-next-line max-statements
		async (event: string, data: unknown) => {
			if (event === "connected") {
				if (connectedRef.current) {
					scheduleSync();
				} else {
					connectedRef.current = true;
				}
				return;
			}
			if (event === "sse_closed") {
				scheduleSync();
				return;
			}

			// A queued event of the previous account must not be written into
			// the new account's database: the repositories resolve getDB()
			// from the account active at the moment of the write.
			if (
				userIdRef.current !== undefined &&
				getActiveAccountKey() !== userIdRef.current
			) {
				return;
			}

			if (isCallEvent(event)) {
				routeCallEvent(callManager, event, data);
				return;
			}
			if (event === "bot_callback_answer") {
				void showBotCallbackAnswer(data, userIdRef.current);
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
			if (event === "thread_message_updated") {
				const { threadId, message } = data as {
					threadId: string;
					message: Message;
				};
				await upsertThreadMessage(message, threadId);
				return;
			}
			if (event === "message_reactions_updated") {
				await applyReactionsEvent(
					data as { messageId: string; reactions: ReactionSummary[] },
				);
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
			if (event === "chat_pinned") {
				await applyChatPinEvent(
					data as { chatId: string; messageId: string; pinned: boolean },
				);
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
				await upsertThreadMessage(message, threadId);
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
		},
		[addTypingUser, clearTyping, onTokenExpiring, onTokenExpired, callManager],
	);

	useSse(token, handler);
}
