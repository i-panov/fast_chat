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
	setActiveThreadMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export function useThreads({
	token,
	chatId,
}: UseThreadsParams): UseThreadsReturn {
	const [threads, setThreads] = useState<Record<string, Thread>>({});
	const [messageToThread, setMessageToThread] = useState<
		Record<string, string>
	>({});
	const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
	const [activeThreadMessages, setActiveThreadMessages] = useState<Message[]>(
		[],
	);
	const [threadHasMore, setThreadHasMore] = useState(false);
	const [threadIsLoadingMore, setThreadIsLoadingMore] = useState(false);

	const threadMessagesRef = useRef<Record<string, Message[]>>({});
	const threadNextCursorsRef = useRef<Record<string, string | null>>({});
	const threadLoadingMoreRef = useRef(false);

	// Загрузка веток при смене чата
	useEffect(() => {
		if (!token || !chatId) {
			setThreads({});
			setMessageToThread({});
			return;
		}

		getThreads(token, chatId)
			.then(({ threads: ts }) => {
				const threadMap: Record<string, Thread> = {};
				const msgToThread: Record<string, string> = {};
				for (const t of ts) {
					threadMap[t.id] = t;
					msgToThread[t.parentMessageId] = t.id;
				}
				setThreads((prev) => ({ ...prev, ...threadMap }));
				setMessageToThread((prev) => ({ ...prev, ...msgToThread }));
			})
			.catch(() => {
				/* ignore */
			});
	}, [token, chatId]);

	// Загрузка сообщений активной ветки
	useEffect(() => {
		if (!token || !activeThreadId) {
			setActiveThreadMessages([]);
			return;
		}

		if (threadMessagesRef.current[activeThreadId] !== undefined) {
			setActiveThreadMessages(threadMessagesRef.current[activeThreadId]);
			return;
		}

		const thread = threads[activeThreadId];
		if (!thread) return;

		getThreadMessages(token, thread.chatId, activeThreadId, 30)
			.then(({ messages: msgs, nextCursor }) => {
				threadMessagesRef.current[activeThreadId] = msgs;
				setActiveThreadMessages(msgs);
				const nxt = nextCursor;
				threadNextCursorsRef.current[activeThreadId] =
					nxt != null && nxt !== "" ? nxt : null;
				setThreadHasMore(nxt != null && nxt !== "");
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadMessages"));
			});
	}, [activeThreadId, token, threads]);

	const createThread = useCallback(
		async (chatId: string, messageId: string) => {
			if (!token) return;

			try {
				const { thread } = await apiCreateThread(token, chatId, messageId);
				setThreads((prev) => ({ ...prev, [thread.id]: thread }));
				setMessageToThread((prev) => ({
					...prev,
					[thread.parentMessageId]: thread.id,
				}));
				setActiveThreadId(thread.id);
			} catch {
				// Пробуем найти существующую ветку
				try {
					const { threads: ts } = await getThreads(token, chatId);
					const existing = ts.find((t) => t.parentMessageId === messageId);
					if (existing) {
						setThreads((prev) => ({ ...prev, [existing.id]: existing }));
						setMessageToThread((prev) => ({
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
		[token],
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
			const thread = threads[activeThreadId];
			if (!thread) return;

			const res = await getThreadMessages(
				token,
				thread.chatId,
				activeThreadId,
				30,
				cursor,
			);
			const existing = threadMessagesRef.current[activeThreadId] ?? [];
			threadMessagesRef.current[activeThreadId] = [
				...res.messages,
				...existing,
			];
			setActiveThreadMessages(threadMessagesRef.current[activeThreadId]);
			const nxt = res.nextCursor;
			threadNextCursorsRef.current[activeThreadId] =
				nxt != null && nxt !== "" ? nxt : null;
			setThreadHasMore(nxt != null && nxt !== "");
		} catch {
			emitNotification(i18n.t("error.loadMessages"));
		} finally {
			setThreadIsLoadingMore(false);
			threadLoadingMoreRef.current = false;
		}
	}, [activeThreadId, token, threads]);

	const activeThread = activeThreadId
		? (threads[activeThreadId] ?? null)
		: null;

	return {
		threads,
		messageToThread,
		activeThreadId,
		activeThread,
		activeThreadMessages,
		threadHasMore,
		threadIsLoadingMore,
		createThread,
		openThread,
		closeThread,
		loadMoreThreadMessages,
		setActiveThreadMessages,
	};
}
