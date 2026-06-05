import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, Thread } from "../api.ts";
import {
	createThread as apiCreateThread,
	getThreadMessages,
	getThreads,
} from "../api.ts";
import i18n from "../i18n.ts";
import { emitNotification } from "../utils/notify.ts";

interface UseThreadsParams {
	token: string | undefined;
	chatId: string | null;
	threadsMap: Record<string, Thread>;
	setThreadsMap: React.Dispatch<React.SetStateAction<Record<string, Thread>>>;
	messageToThreadMap: Record<string, string>;
	setMessageToThreadMap: React.Dispatch<
		React.SetStateAction<Record<string, string>>
	>;
	threadMessagesMap: Record<string, Message[]>;
	setThreadMessagesMap: React.Dispatch<
		React.SetStateAction<Record<string, Message[]>>
	>;
}

interface UseThreadsReturn {
	threads: Record<string, Thread>;
	messageToThread: Record<string, string>;
	activeThreadId: string | null;
	activeThread: Thread | null;
	activeThreadMessages: Message[];
	threadHasMore: boolean;
	threadIsLoadingMore: boolean;
	createThread: (chatId: string, messageId: string) => Promise<void>;
	openThread: (threadId: string) => void;
	closeThread: () => void;
	loadMoreThreadMessages: () => Promise<void>;
}

const PAGE_SIZE = 30;

export function useThreads({
	token,
	chatId,
	threadsMap,
	setThreadsMap,
	messageToThreadMap,
	setMessageToThreadMap,
	threadMessagesMap,
	setThreadMessagesMap,
}: UseThreadsParams): UseThreadsReturn {
	const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
	const [threadHasMore, setThreadHasMore] = useState(false);
	const [threadIsLoadingMore, setThreadIsLoadingMore] = useState(false);

	const threadNextCursorsRef = useRef<Record<string, string | null>>({});
	const threadLoadingMoreRef = useRef(false);

	// Загрузка веток при смене чата
	useEffect(() => {
		if (!token || !chatId) return;

		getThreads(token, chatId)
			.then(({ threads: ts }) => {
				const threadMap: Record<string, Thread> = {};
				const msgToThread: Record<string, string> = {};
				for (const t of ts) {
					threadMap[t.id] = t;
					msgToThread[t.parentMessageId] = t.id;
				}
				setThreadsMap((prev) => ({ ...prev, ...threadMap }));
				setMessageToThreadMap((prev) => ({ ...prev, ...msgToThread }));
			})
			.catch(() => {
				/* ignore */
			});
	}, [token, chatId, setThreadsMap, setMessageToThreadMap]);

	// Загрузка сообщений активной ветки
	useEffect(() => {
		if (!token || !activeThreadId) {
			setThreadHasMore(false);
			return;
		}

		if (threadMessagesMap[activeThreadId] !== undefined) {
			setThreadHasMore(threadNextCursorsRef.current[activeThreadId] !== null);
			return;
		}

		const thread = threadsMap[activeThreadId];
		if (!thread) return;

		getThreadMessages(token, thread.chatId, activeThreadId, PAGE_SIZE)
			.then(({ messages: msgs, nextCursor }) => {
				setThreadMessagesMap((prev) => ({
					...prev,
					[activeThreadId]: msgs,
				}));
				const nxt = nextCursor != null && nextCursor !== "" ? nextCursor : null;
				threadNextCursorsRef.current[activeThreadId] = nxt;
				setThreadHasMore(nxt !== null);
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadMessages"));
			});
	}, [
		activeThreadId,
		token,
		threadsMap,
		threadMessagesMap,
		setThreadMessagesMap,
	]);

	const createThread = useCallback(
		async (chatId: string, messageId: string) => {
			if (!token) return;

			try {
				const { thread } = await apiCreateThread(token, chatId, messageId);
				setThreadsMap((prev) => ({ ...prev, [thread.id]: thread }));
				setMessageToThreadMap((prev) => ({
					...prev,
					[thread.parentMessageId]: thread.id,
				}));
				setActiveThreadId(thread.id);
			} catch {
				try {
					const { threads: ts } = await getThreads(token, chatId);
					const existing = ts.find((t) => t.parentMessageId === messageId);
					if (existing) {
						setThreadsMap((prev) => ({ ...prev, [existing.id]: existing }));
						setMessageToThreadMap((prev) => ({
							...prev,
							[messageId]: existing.id,
						}));
						setActiveThreadId(existing.id);
						return;
					}
				} catch {
					/* ignore */
				}
				emitNotification(i18n.t("error.createThread"));
			}
		},
		[token, setThreadsMap, setMessageToThreadMap],
	);

	const openThread = useCallback((threadId: string) => {
		setActiveThreadId(threadId);
	}, []);

	const closeThread = useCallback(() => {
		setActiveThreadId(null);
	}, []);

	const loadMoreThreadMessages = useCallback(async () => {
		if (!activeThreadId || !token) return;
		if (threadLoadingMoreRef.current) return;

		const cursor = threadNextCursorsRef.current[activeThreadId];
		if (!cursor) return;

		threadLoadingMoreRef.current = true;
		setThreadIsLoadingMore(true);

		try {
			const thread = threadsMap[activeThreadId];
			if (!thread) return;

			const res = await getThreadMessages(
				token,
				thread.chatId,
				activeThreadId,
				PAGE_SIZE,
				cursor,
			);
			setThreadMessagesMap((prev) => ({
				...prev,
				[activeThreadId]: [...res.messages, ...(prev[activeThreadId] ?? [])],
			}));
			const nxt =
				res.nextCursor != null && res.nextCursor !== "" ? res.nextCursor : null;
			threadNextCursorsRef.current[activeThreadId] = nxt;
			setThreadHasMore(nxt !== null);
		} catch {
			emitNotification(i18n.t("error.loadMessages"));
		} finally {
			setThreadIsLoadingMore(false);
			threadLoadingMoreRef.current = false;
		}
	}, [activeThreadId, token, threadsMap, setThreadMessagesMap]);

	const activeThread = activeThreadId
		? (threadsMap[activeThreadId] ?? null)
		: null;
	const activeThreadMessages =
		activeThreadId !== null ? (threadMessagesMap[activeThreadId] ?? []) : [];

	return {
		threads: threadsMap,
		messageToThread: messageToThreadMap,
		activeThreadId,
		activeThread,
		activeThreadMessages,
		threadHasMore,
		threadIsLoadingMore,
		createThread,
		openThread,
		closeThread,
		loadMoreThreadMessages,
	};
}
