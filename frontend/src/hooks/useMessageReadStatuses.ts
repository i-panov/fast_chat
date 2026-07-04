import { useCallback, useEffect, useRef } from "react";
import { markMessagesRead } from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
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

	const flush = useCallback(async () => {
		if (pendingRef.current.size === 0) return;
		if (token === undefined || chatId === null || userId === undefined) return;

		const messageIds = Array.from(pendingRef.current).slice(0, MAX_BATCH_SIZE);
		pendingRef.current.clear();

		try {
			await markMessagesRead(token, chatId, messageIds);
			if (isInThread === true) {
				await threadMessagesRepo.markAsRead(messageIds);
			} else {
				await messagesRepo.markAsRead(messageIds);
			}
		} catch {
			// Re-add failed messages to pending for retry
			for (const id of messageIds) {
				pendingRef.current.add(id);
			}
		}
	}, [token, chatId, userId, isInThread]);

	const scheduleFlush = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
		}
		timerRef.current = setTimeout(() => {
			void flush();
		}, DEBOUNCE_MS);
	}, [flush]);

	const markVisibleAsRead = useCallback(
		(messageIds: string[]) => {
			if (userId === undefined || chatId === null) return;

			// Filter out own messages
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
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	return { markVisibleAsRead };
}
