import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../api.ts";
import { getMessages } from "../api.ts";
import i18n from "../i18n.ts";
import { emitNotification } from "../utils/notify.ts";

interface UseMessagesParams {
	token: string | undefined;
	chatId: string | null;
}

interface UseMessagesReturn {
	messages: Message[];
	hasMore: boolean;
	isLoadingMore: boolean;
	loadMore: () => Promise<void>;
	refreshMessages: (chatId: string) => Promise<void>;
}

export function useMessages({
	token,
	chatId,
}: UseMessagesParams): UseMessagesReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [isLoadingMore, setIsLoadingMore] = useState(false);

	const messagesRef = useRef<Record<string, Message[]>>({});
	const nextCursorsRef = useRef<Record<string, string | null>>({});
	const loadingMoreRef = useRef(false);

	// Загрузка сообщений при смене чата
	useEffect(() => {
		if (!token || !chatId) {
			setMessages([]);
			return;
		}

		if (messagesRef.current[chatId]) {
			setMessages(messagesRef.current[chatId]);
			return;
		}

		getMessages(token, chatId, 30)
			.then(({ messages: msgs, nextCursor }) => {
				messagesRef.current[chatId] = msgs;
				setMessages(msgs);
				const nxt = nextCursor;
				nextCursorsRef.current[chatId] = nxt != null && nxt !== "" ? nxt : null;
				setHasMore(nxt != null && nxt !== "");
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadMessages"));
			});
	}, [token, chatId]);

	const refreshMessages = useCallback(
		async (newChatId: string) => {
			if (!token) return;

			try {
				const { messages: msgs, nextCursor } = await getMessages(
					token,
					newChatId,
					30,
				);
				messagesRef.current[newChatId] = msgs;
				setMessages(msgs);
				const nxt = nextCursor;
				nextCursorsRef.current[newChatId] =
					nxt != null && nxt !== "" ? nxt : null;
				setHasMore(nxt != null && nxt !== "");
			} catch {
				emitNotification(i18n.t("error.loadMessages"));
			}
		},
		[token],
	);

	const loadMore = useCallback(async () => {
		if (!chatId || !token) return;
		if (loadingMoreRef.current) return;

		const cursor = nextCursorsRef.current[chatId];
		if (!cursor) return;

		loadingMoreRef.current = true;
		setIsLoadingMore(true);

		try {
			const res = await getMessages(token, chatId, 30, cursor);
			const existing = messagesRef.current[chatId] ?? [];
			messagesRef.current[chatId] = [...res.messages, ...existing];
			setMessages(messagesRef.current[chatId]);
			const nxt = res.nextCursor;
			nextCursorsRef.current[chatId] = nxt != null && nxt !== "" ? nxt : null;
			setHasMore(nxt != null && nxt !== "");
		} catch {
			emitNotification(i18n.t("error.loadMessages"));
		} finally {
			setIsLoadingMore(false);
			loadingMoreRef.current = false;
		}
	}, [chatId, token]);

	return {
		messages,
		hasMore,
		isLoadingMore,
		loadMore,
		refreshMessages,
	};
}
