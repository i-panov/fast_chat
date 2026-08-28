import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createThread as apiCreateThread,
	getThreadMessages,
	getThreads,
} from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { StoredThread, StoredThreadMessage } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import { useLiveQuery } from "../db/useLiveQuery.ts";
import { getMyKeyPair } from "../e2ee/keys.ts";
import { decryptMessage, decryptMessageText } from "../e2ee/message.ts";
import i18n from "../i18n.ts";
import type { Message, Thread } from "../types/api.ts";
import { useAuth } from "../useAuth.tsx";
import { stripMeta } from "../utils/helpers.ts";
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
	knownThreadIdsRef: React.MutableRefObject<Set<string>>;
}

const PAGE_SIZE = 30;

export function useThreads({
	token,
	chatId,
}: UseThreadsParams): UseThreadsReturn {
	const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
	const [threadHasMore, setThreadHasMore] = useState(false);
	const [threadIsLoadingMore, setThreadIsLoadingMore] = useState(false);

	const threadNextCursorsRef = useRef<Record<string, string | null>>({});
	const threadLoadingMoreRef = useRef(false);
	const knownThreadIdsRef = useRef<Set<string>>(new Set());

	const allStored = useLiveQuery<StoredThread[]>(
		useCallback(() => {
			if (chatId === null) return Promise.resolve([]);
			return threadsRepo.getByChat(chatId);
		}, [chatId]),
	);

	const activeThreadMessagesStored = useLiveQuery<StoredThreadMessage[]>(
		useCallback(() => {
			if (activeThreadId === null) return Promise.resolve([]);
			return threadMessagesRepo.getByThread(activeThreadId);
		}, [activeThreadId]),
	);

	const { threadsMap, messageToThread } = useMemo(() => {
		const tm: Record<string, Thread> = {};
		const mt: Record<string, string> = {};
		if (allStored) {
			for (const t of allStored) {
				const thread = stripMeta(t);
				tm[thread.id] = thread;
				mt[thread.parentMessageId] = thread.id;
			}
		}
		return { threadsMap: tm, messageToThread: mt };
	}, [allStored]);

	const { activeAccount } = useAuth();
	const userId = activeAccount?.user.id;

	const [decryptedThreadMessages, setDecryptedThreadMessages] = useState<
		Message[]
	>([]);

	useEffect(() => {
		let alive = true;

		(async () => {
			const key = await getMyKeyPair();
			const out: Message[] = [];

			for (const m of activeThreadMessagesStored ?? []) {
				const { _updatedAt: _u, threadId: _tid, status: _s, ...rest } = m;
				void _u;
				void _tid;
				void _s;
				const decrypted: Message =
					userId !== undefined
						? await decryptMessage(m, userId, key)
						: (rest as Message);
				out.push(decrypted);
			}

			if (alive) setDecryptedThreadMessages(out);
		})();

		return () => {
			alive = false;
		};
	}, [activeThreadMessagesStored, userId]);

	const activeThreadMessages = decryptedThreadMessages;

	// The thread header shows the parent message text, which is encrypted
	// on the server. Resolve it from the parent message's own record.
	const [threadParentText, setThreadParentText] = useState<
		Record<string, string>
	>({});

	useEffect(() => {
		let alive = true;

		(async () => {
			const key = await getMyKeyPair();
			const entries: Array<[string, string]> = [];

			for (const t of Object.values(threadsMap)) {
				const parent = await messagesRepo.getByIdAny(t.parentMessageId);

				if (parent === undefined) {
					entries.push([t.id, t.parentMessageText]);
					continue;
				}

				if (!parent.encrypted) {
					entries.push([t.id, parent.text]);
					continue;
				}

				if (userId !== undefined && key !== null) {
					let parentText: string;
					try {
						parentText = await decryptMessageText(parent, userId, key);
					} catch {
						parentText = i18n.t("message.undecryptable");
					}
					entries.push([t.id, parentText]);
				} else {
					entries.push([t.id, i18n.t("message.undecryptable")]);
				}
			}

			if (alive) setThreadParentText(Object.fromEntries(entries));
		})();

		return () => {
			alive = false;
		};
	}, [threadsMap, userId]);

	useEffect(() => {
		if (allStored) {
			knownThreadIdsRef.current = new Set(allStored.map((t) => t.id));
		}
	}, [allStored]);

	// Fetch threads from server on chat change
	useEffect(() => {
		if (!token || !chatId) return;

		getThreads(token, chatId)
			.then(({ threads: ts }) => {
				if (ts.length > 0) {
					void threadsRepo.upsertMany(ts);
				}
			})
			.catch(() => {});
	}, [token, chatId]);

	// Load thread messages from server when opening a thread
	useEffect(() => {
		if (!token || !activeThreadId) {
			setThreadHasMore(false);
			return;
		}

		if (activeThreadMessagesStored && activeThreadMessagesStored.length > 0) {
			setThreadHasMore(threadNextCursorsRef.current[activeThreadId] !== null);
			return;
		}

		const thread = threadsMap[activeThreadId];
		if (!thread) return;

		getThreadMessages(token, thread.chatId, activeThreadId, PAGE_SIZE)
			.then(({ messages: msgs, nextCursor }) => {
				void threadMessagesRepo.upsertMany(msgs, activeThreadId);
				const nxt = nextCursor != null && nextCursor !== "" ? nextCursor : null;
				threadNextCursorsRef.current[activeThreadId] = nxt;
				setThreadHasMore(nxt !== null);
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadMessages"));
			});
	}, [activeThreadId, token, activeThreadMessagesStored, threadsMap]);

	const createThread = useCallback(
		async (cId: string, messageId: string) => {
			if (!token) return;

			try {
				const { thread } = await apiCreateThread(token, cId, messageId);
				await threadsRepo.upsert(thread);
				setActiveThreadId(thread.id);
			} catch {
				try {
					const { threads: ts } = await getThreads(token, cId);
					const existing = ts.find((t) => t.parentMessageId === messageId);
					if (existing) {
						await threadsRepo.upsert(existing);
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

		if (typeof navigator !== "undefined" && !navigator.onLine) {
			setThreadHasMore(false);
			return;
		}

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
			await threadMessagesRepo.upsertMany(res.messages, activeThreadId);
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
	}, [activeThreadId, token, threadsMap]);

	const activeThread = activeThreadId
		? (threadsMap[activeThreadId] ?? null)
		: null;

	const activeThreadWithText =
		activeThread !== null && threadParentText[activeThread.id] !== undefined
			? {
					...activeThread,
					parentMessageText: threadParentText[activeThread.id],
				}
			: activeThread;

	return {
		threads: threadsMap,
		messageToThread,
		activeThreadId,
		activeThread: activeThreadWithText,
		activeThreadMessages,
		threadHasMore,
		threadIsLoadingMore,
		createThread,
		openThread,
		closeThread,
		loadMoreThreadMessages,
		knownThreadIdsRef,
	};
}
