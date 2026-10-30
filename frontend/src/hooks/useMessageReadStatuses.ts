import { useCallback, useEffect, useRef } from "react";
import { markMessagesRead } from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { extractRetryAfterMs } from "../sync/outboxProcessor.ts";
import { useAuth } from "../useAuth.tsx";

const DEBOUNCE_MS = 300;
const MAX_BATCH_SIZE = 50;

interface UseMessageReadStatusesParams {
	token: string | undefined;
	chatId: string | null;
	isInThread?: boolean;
}

export function useMessageReadStatuses({
	token,
	chatId,
	isInThread,
}: UseMessageReadStatusesParams) {
	const { activeAccount } = useAuth();
	const userId = activeAccount?.user.id;
	const pendingRef = useRef<Set<string>>(new Set());
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const nextAllowedFlushRef = useRef(0);
	const flushRef = useRef<() => Promise<void>>(async () => {});
	const scheduleFlushRef = useRef<(() => void) | null>(null);

	const flush = useCallback(async () => {
		if (pendingRef.current.size === 0) return;
		if (token === undefined || chatId === null || userId === undefined) return;

		// Send at most one batch; only the sent IDs leave the queue so a
		// batch >50 keeps its tail instead of dropping it.
		const messageIds = Array.from(pendingRef.current).slice(0, MAX_BATCH_SIZE);
		for (const id of messageIds) {
			pendingRef.current.delete(id);
		}

		try {
			await markMessagesRead(token, chatId, messageIds);
			if (isInThread === true) {
				await threadMessagesRepo.markAsRead(messageIds);
			} else {
				await messagesRepo.markAsRead(messageIds);
			}
			// A leftover tail schedules its own flush.
			if (pendingRef.current.size > 0) {
				scheduleFlushRef.current?.();
			}
		} catch (err) {
			// Re-add failed messages to pending for retry
			for (const id of messageIds) {
				pendingRef.current.add(id);
			}

			// Back off after 429 (rate limiting): don't retry before the
			// server's Retry-After, otherwise every re-render would fire
			// another request and keep the limiter saturated.
			const retryAfterMs = extractRetryAfterMs(err);
			if (retryAfterMs !== null) {
				nextAllowedFlushRef.current = Date.now() + retryAfterMs;
			}
		}
	}, [token, chatId, userId, isInThread]);

	const scheduleFlush = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
		}
		const wait = Math.max(
			DEBOUNCE_MS,
			nextAllowedFlushRef.current - Date.now(),
		);
		timerRef.current = setTimeout(() => {
			void flush();
		}, wait);
	}, [flush]);

	useEffect(() => {
		flushRef.current = flush;
		scheduleFlushRef.current = scheduleFlush;
	}, [flush, scheduleFlush]);

	const markVisibleAsRead = useCallback(
		(messageIds: string[]) => {
			if (userId === undefined || chatId === null) return;

			// Callers (MessageList) are expected to pass only other users'
			// messages; the server would reject reads of own messages anyway.
			for (const id of messageIds) {
				pendingRef.current.add(id);
			}

			if (pendingRef.current.size >= MAX_BATCH_SIZE) {
				void flush();
			} else {
				scheduleFlush();
			}
		},
		[userId, chatId, flush, scheduleFlush],
	);

	useEffect(() => {
		// Copy the ref into the effect: the cleanup runs after unmount when
		// the ref object may already be detached.
		const pending = pendingRef.current;
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			// Best-effort flush on unmount so queued reads are not lost when
			// the chat closes before the debounce fires.
			if (pending.size > 0) {
				void flushRef.current();
			}
		};
	}, []);
	return { markVisibleAsRead };
}
