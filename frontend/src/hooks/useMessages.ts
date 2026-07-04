import { useCallback, useEffect, useRef, useState } from "react";
import { getMessages } from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { StoredMessage } from "../db/schema.ts";
import { useLiveQuery } from "../db/useLiveQuery.ts";
import i18n from "../i18n.ts";
import type { Message, MessageStatus } from "../types/api.ts";
import { stripMeta } from "../utils/helpers.ts";
import { emitNotification } from "../utils/notify.ts";

export interface MessageWithStatus extends Message {
	status: MessageStatus;
}

interface UseMessagesParams {
	token: string | undefined;
	chatId: string | null;
}

interface UseMessagesReturn {
	messages: MessageWithStatus[];
	hasMore: boolean;
	isLoadingMore: boolean;
	loadMore: () => Promise<void>;
}

const PAGE_SIZE = 30;

function toClientMessage(sm: StoredMessage): MessageWithStatus {
	const base = stripMeta(sm);
	const status: MessageStatus = sm.status === "deleted" ? "sent" : sm.status;
	return {
		...base,
		status,
		deliveryStatus: sm.deliveryStatus,
		readBy: sm.readBy,
	};
}

export function useMessages({
	token,
	chatId,
}: UseMessagesParams): UseMessagesReturn {
	const [hasMore, setHasMore] = useState(false);
	const [isLoadingMore, setIsLoadingMore] = useState(false);

	const nextCursorsRef = useRef<Record<string, string | null>>({});
	const loadingMoreRef = useRef(false);

	const query = useCallback(() => {
		if (chatId === null) return Promise.resolve([] as StoredMessage[]);
		return messagesRepo.getByChat(chatId);
	}, [chatId]);
	const stored = useLiveQuery<StoredMessage[]>(query);

	const visible = (stored ?? [])
		.filter((m) => m.status !== "deleted")
		.map(toClientMessage);

	const loadMore = useCallback(async () => {
		if (chatId === null || token === undefined) return;
		if (loadingMoreRef.current) return;

		const cursor = nextCursorsRef.current[chatId] ?? null;
		if (cursor === null && nextCursorsRef.current[chatId] !== undefined) return;

		if (typeof navigator !== "undefined" && !navigator.onLine) {
			setHasMore(false);
			return;
		}

		loadingMoreRef.current = true;
		setIsLoadingMore(true);

		try {
			// Get list of message IDs already in cache
			const cachedMessages = await messagesRepo.getByChat(chatId);
			const cachedIds = cachedMessages.map((m) => m.id);

			// Fetch messages with status info for missing IDs
			const res = await getMessages(token, chatId, {
				limit: PAGE_SIZE,
				before: cursor === null ? undefined : cursor,
				missingIDs: cachedIds,
			});

			await messagesRepo.upsertMany(res.messages);

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
	}, [chatId, token]);

	useEffect(() => {
		if (chatId === null || token === undefined) {
			setHasMore(false);
			return;
		}
		if (nextCursorsRef.current[chatId] === undefined) {
			loadMore();
		} else {
			setHasMore(nextCursorsRef.current[chatId] !== null);
		}
	}, [chatId, token, loadMore]);

	return {
		messages: visible,
		hasMore,
		isLoadingMore,
		loadMore,
	};
}
