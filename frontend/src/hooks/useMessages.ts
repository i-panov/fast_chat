import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../api.ts";
import { getMessages } from "../api.ts";
import i18n from "../i18n.ts";
import { emitNotification } from "../utils/notify.ts";

interface UseMessagesParams {
	token: string | undefined;
	chatId: string | null;
	messagesMap: Record<string, Message[]>;
	setMessagesMap: React.Dispatch<
		React.SetStateAction<Record<string, Message[]>>
	>;
}

interface UseMessagesReturn {
	messages: Message[];
	hasMore: boolean;
	isLoadingMore: boolean;
	loadMore: () => Promise<void>;
}

const PAGE_SIZE = 30;

function setMap(
	map: Record<string, Message[]>,
	chatId: string,
	updater: (prev: Message[]) => Message[],
): Record<string, Message[]> {
	return { ...map, [chatId]: updater(map[chatId] ?? []) };
}

export function useMessages({
	token,
	chatId,
	messagesMap,
	setMessagesMap,
}: UseMessagesParams): UseMessagesReturn {
	const [hasMore, setHasMore] = useState(false);
	const [isLoadingMore, setIsLoadingMore] = useState(false);

	const nextCursorsRef = useRef<Record<string, string | null>>({});
	const loadingMoreRef = useRef(false);

	// Загрузка сообщений при смене чата
	useEffect(() => {
		if (!token || !chatId) {
			setHasMore(false);
			return;
		}

		if (messagesMap[chatId] !== undefined) {
			setHasMore(nextCursorsRef.current[chatId] !== null);
			return;
		}

		getMessages(token, chatId, PAGE_SIZE)
			.then(({ messages: msgs, nextCursor }) => {
				setMessagesMap((prev) => ({ ...prev, [chatId]: msgs }));
				const nxt = nextCursor != null && nextCursor !== "" ? nextCursor : null;
				nextCursorsRef.current[chatId] = nxt;
				setHasMore(nxt !== null);
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadMessages"));
			});
	}, [token, chatId, messagesMap, setMessagesMap]);

	const loadMore = useCallback(async () => {
		if (!chatId || !token) return;
		if (loadingMoreRef.current) return;

		const cursor = nextCursorsRef.current[chatId];
		if (!cursor) return;

		loadingMoreRef.current = true;
		setIsLoadingMore(true);

		try {
			const res = await getMessages(token, chatId, PAGE_SIZE, cursor);
			setMessagesMap((prev) =>
				setMap(prev, chatId, (existing) => [...res.messages, ...existing]),
			);
			const nxt =
				res.nextCursor != null && res.nextCursor !== "" ? res.nextCursor : null;
			nextCursorsRef.current[chatId] = nxt;
			setHasMore(nxt !== null);
		} catch {
			emitNotification(i18n.t("error.loadMessages"));
		} finally {
			setIsLoadingMore(false);
			loadingMoreRef.current = false;
		}
	}, [chatId, token, setMessagesMap]);

	const messages = chatId !== null ? (messagesMap[chatId] ?? []) : [];

	return {
		messages,
		hasMore,
		isLoadingMore,
		loadMore,
	};
}
