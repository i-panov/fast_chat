import { useCallback, useEffect, useRef, useState } from "react";
import { sendTyping } from "../api.ts";
import type { TypingPayload } from "../types/api.ts";

interface UseTypingParams {
	token: string | undefined;
}

interface UseTypingReturn {
	typingUsers: Record<string, TypingPayload[]>;
	handleTyping: (chatId: string, active: boolean) => void;
	clearTyping: (chatId: string, userId: string) => void;
	addTypingUser: (payload: TypingPayload) => void;
}

const TYPING_TIMEOUT = 3000;
const TYPING_THROTTLE = 2000;

export function useTyping({ token }: UseTypingParams): UseTypingReturn {
	const [typingUsers, setTypingUsers] = useState<
		Record<string, TypingPayload[]>
	>({});

	const typingTimersRef = useRef<Record<string, number>>({});
	const lastTypingSent = useRef<Record<string, number>>({});

	const handleTyping = useCallback(
		(chatId: string, active: boolean) => {
			if (!token) return;

			if (active) {
				const now = Date.now();
				const last = lastTypingSent.current[chatId] ?? 0;
				if (now - last < TYPING_THROTTLE) return;
				lastTypingSent.current[chatId] = now;
			}

			sendTyping(token, chatId, active).catch(() => {
				/* ignore */
			});
		},
		[token],
	);

	const clearTyping = useCallback((chatId: string, userId: string) => {
		const timerKey = `${chatId}:${userId}`;
		if (typingTimersRef.current[timerKey]) {
			clearTimeout(typingTimersRef.current[timerKey]);
			delete typingTimersRef.current[timerKey];
		}

		setTypingUsers((prev) => {
			const list = (prev[chatId] ?? []).filter((t) => t.userId !== userId);
			if (list.length === 0) {
				const { [chatId]: _, ...rest } = prev;
				return rest;
			}
			return { ...prev, [chatId]: list };
		});
	}, []);

	// Автоматическая очистка индикаторов набора
	useEffect(() => {
		return () => {
			// Очистка всех таймеров при размонтировании
			Object.values(typingTimersRef.current).forEach((timerId) => {
				clearTimeout(timerId);
			});
		};
	}, []);

	// Метод для установки таймера остановки набора
	const setTypingTimeout = useCallback(
		(chatId: string, userId: string) => {
			const timerKey = `${chatId}:${userId}`;
			if (typingTimersRef.current[timerKey]) {
				clearTimeout(typingTimersRef.current[timerKey]);
			}

			typingTimersRef.current[timerKey] = window.setTimeout(() => {
				clearTyping(chatId, userId);
			}, TYPING_TIMEOUT);
		},
		[clearTyping],
	);

	// Метод для добавления пользователя в список набирающих
	const addTypingUser = useCallback(
		(payload: TypingPayload) => {
			setTypingUsers((prev) => {
				const list = prev[payload.chatId] ?? [];
				if (list.some((t) => t.userId === payload.userId)) {
					return prev;
				}
				return { ...prev, [payload.chatId]: [...list, payload] };
			});

			setTypingTimeout(payload.chatId, payload.userId);
		},
		[setTypingTimeout],
	);

	return {
		typingUsers,
		handleTyping,
		clearTyping,
		addTypingUser,
	};
}
