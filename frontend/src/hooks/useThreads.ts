import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createThread as apiCreateThread,
	getThreadMessages,
	getThreads,
} from "../api.ts";
import { getActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { StoredThread, StoredThreadMessage } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import { useLiveQuery } from "../db/useLiveQuery.ts";
import type { KeyPair } from "../e2ee/crypto.ts";
import {
	getMyKeyPair,
	hasLocalLock,
	isLocalLockUnlocked,
} from "../e2ee/keys.ts";
import { decryptMessage, decryptMessageContent } from "../e2ee/message.ts";
import i18n from "../i18n.ts";
import type { Message, Thread } from "../types/api.ts";
import { useAuth } from "../useAuth.tsx";
import { stripMeta } from "../utils/helpers.ts";
import { emitNotification } from "../utils/notify.ts";
import { useLocalLockRevision } from "./useLocalLockRevision.ts";

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
}

const PAGE_SIZE = 30;

// decryptMessageContentSafe resolves a parent preview. A payload without v3
// content is not renderable and is reported as undecryptable by the caller.
async function decryptMessageContentSafe(
	parent: {
		text: string;
		encryptedPayload?: string;
		location?: { lat: number; lng: number };
	},
	userId: string,
	key: KeyPair,
): Promise<string> {
	const content = await decryptMessageContent(parent, userId, key);
	if (content === null) throw new Error("undecryptable content");
	return content.text;
}

function useDecryptedThreadMessages(
	activeThreadMessagesStored: StoredThreadMessage[] | undefined,
	userId: string | undefined,
): Message[] {
	const [decryptedThreadMessages, setDecryptedThreadMessages] = useState<
		Message[]
	>([]);
	const lockRevision = useLocalLockRevision();

	useEffect(() => {
		let alive = true;
		// Recompute cached undecryptable rows after a local lock change.
		void lockRevision;

		void (async () => {
			let locked = false;
			try {
				locked = (await hasLocalLock()) && !isLocalLockUnlocked();
			} catch {
				locked = false;
			}
			if (locked) {
				if (alive) setDecryptedThreadMessages([]);
				return;
			}
			const key = await getMyKeyPair();
			// Decrypt in parallel: thread pages are small (PAGE_SIZE) and each
			// item is independent, so sequential awaits only add latency.
			const out = await Promise.all(
				(activeThreadMessagesStored ?? []).map(async (m) => {
					// A tombstone is a deleted message: rendering it as a normal
					// row keeps the deleted content on screen (and resurrects it
					// after a reload), so it is filtered out like in the main feed.
					if (m.status === "deleted") return null;
					const { _updatedAt: _u, threadId: _tid, status, ...rest } = m;
					void _u;
					void _tid;
					const message =
						userId === undefined ? rest : await decryptMessage(m, userId, key);
					// Thread rows carry the same queued/failed state as the main
					// feed; dropping it makes a failed send look delivered and
					// removes retry/cancel from the message menu.
					return {
						...message,
						status,
					};
				}),
			);

			if (alive) {
				setDecryptedThreadMessages(out.flatMap((m) => (m === null ? [] : [m])));
			}
		})().catch(() => {
			// A DB reset during teardown must not become an unhandled rejection.
		});

		return () => {
			alive = false;
		};
	}, [activeThreadMessagesStored, userId, lockRevision]);

	return decryptedThreadMessages;
}

// The thread header shows the parent message text, which is encrypted
// on the server. Resolve it from the parent message's own record.
function useThreadParentText(
	threadsMap: Record<string, Thread>,
	userId: string | undefined,
): Record<string, string> {
	const [threadParentText, setThreadParentText] = useState<
		Record<string, string>
	>({});
	const lockRevision = useLocalLockRevision();

	useEffect(() => {
		let alive = true;
		void lockRevision;

		void (async () => {
			let locked = false;
			try {
				locked = (await hasLocalLock()) && !isLocalLockUnlocked();
			} catch {
				locked = false;
			}
			if (locked) {
				if (alive) setThreadParentText({});
				return;
			}
			const key = await getMyKeyPair();
			const list = Object.values(threadsMap);
			// Parallel parent resolution (IDB read + decrypt per thread).
			const entries = await Promise.all(
				list.map(async (t): Promise<[string, string]> => {
					const parent = await messagesRepo.getByIdAny(t.parentMessageId);

					if (parent === undefined) {
						return [t.id, t.parentMessageText];
					}

					// A deleted parent must not be decrypted back onto the
					// screen; the header simply loses its preview text.
					if (parent.status === "deleted") {
						return [t.id, ""];
					}

					if (!parent.encrypted) {
						return [t.id, parent.text];
					}

					if (userId !== undefined && key !== null) {
						try {
							const content = await decryptMessageContentSafe(
								parent,
								userId,
								key,
							);
							return [t.id, content];
						} catch {
							return [t.id, i18n.t("message.undecryptable")];
						}
					}
					return [t.id, i18n.t("message.undecryptable")];
				}),
			);

			if (alive) setThreadParentText(Object.fromEntries(entries));
		})().catch(() => {
			// A DB reset during teardown must not become an unhandled rejection.
		});

		return () => {
			alive = false;
		};
	}, [threadsMap, userId, lockRevision]);

	return threadParentText;
}

function fetchThreadsFromServer(token: string, chatId: string): Promise<void> {
	const accountKey = getActiveAccountKey();
	return getThreads(token, chatId).then(({ threads: ts }) => {
		// The account may have switched while the request was in flight: the
		// rows belong to the old account's cache.
		if (getActiveAccountKey() !== accountKey) return;
		if (ts.length > 0) {
			void threadsRepo.upsertMany(ts);
		}
	});
}

export function useThreads({
	token,
	chatId,
}: UseThreadsParams): UseThreadsReturn {
	const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
	const [threadHasMore, setThreadHasMore] = useState(false);
	const [threadIsLoadingMore, setThreadIsLoadingMore] = useState(false);

	const threadNextCursorsRef = useRef<Record<string, string | null>>({});
	const threadLoadingMoreRef = useRef(false);
	// Threads opened while a background thread-list sync lands: threadsMap
	// gets a fresh identity on every upsert, which would restart the effect
	// and fire a duplicate initial fetch while one is still in flight.
	const threadInitialFetchRef = useRef<Set<string>>(new Set());

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

	const activeThreadMessages = useDecryptedThreadMessages(
		activeThreadMessagesStored,
		userId,
	);

	const threadParentText = useThreadParentText(threadsMap, userId);

	// The active thread as of the latest render, readable from async
	// callbacks: a response for a thread the user already left must not
	// overwrite the new thread's pagination state.
	const activeThreadIdRef = useRef(activeThreadId);
	useEffect(() => {
		activeThreadIdRef.current = activeThreadId;
	}, [activeThreadId]);

	// Fetch threads from server on chat change
	useEffect(() => {
		if (!token || !chatId) return;

		fetchThreadsFromServer(token, chatId).catch(() => {});
	}, [token, chatId]);

	// Load thread messages from server when opening a thread. The initial
	// fetch always runs once per thread (cursor === undefined), even with a
	// non-empty IDB cache: otherwise a cached page with an unknown cursor
	// sets hasMore=true that loadMore can never satisfy (no cursor).
	useEffect(() => {
		if (!token || !activeThreadId) {
			setThreadHasMore(false);
			return;
		}

		const knownCursor = threadNextCursorsRef.current[activeThreadId];
		if (knownCursor !== undefined) {
			setThreadHasMore(knownCursor !== null);
			return;
		}

		if (threadInitialFetchRef.current.has(activeThreadId)) return;

		const thread = threadsMap[activeThreadId];
		if (!thread) return;

		const tid = activeThreadId;
		const accountKey = getActiveAccountKey();
		threadInitialFetchRef.current.add(tid);
		getThreadMessages(token, thread.chatId, tid, PAGE_SIZE)
			.then(({ messages: msgs, nextCursor }) => {
				if (getActiveAccountKey() !== accountKey) return;
				void threadMessagesRepo.upsertMany(msgs, tid);
				const nxt = nextCursor != null && nextCursor !== "" ? nextCursor : null;
				threadNextCursorsRef.current[tid] = nxt;
				// A fast switch to another thread must not hand it the
				// previous thread's hasMore.
				if (activeThreadIdRef.current === tid) setThreadHasMore(nxt !== null);
			})
			.catch(() => {
				emitNotification(i18n.t("error.loadMessages"));
			})
			.finally(() => {
				threadInitialFetchRef.current.delete(tid);
			});
	}, [activeThreadId, token, threadsMap]);

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
			// Keep hasMore: the history exists, only the network is gone. An
			// "online" listener below retries the page, otherwise the thread
			// would stay truncated until it is reopened.
			return;
		}

		const tid = activeThreadId;
		const accountKey = getActiveAccountKey();
		threadLoadingMoreRef.current = true;
		setThreadIsLoadingMore(true);

		try {
			const thread = threadsMap[tid];
			if (!thread) return;

			const res = await getThreadMessages(
				token,
				thread.chatId,
				tid,
				PAGE_SIZE,
				cursor,
			);
			if (getActiveAccountKey() !== accountKey) return;
			await threadMessagesRepo.upsertMany(res.messages, tid);
			const nxt =
				res.nextCursor != null && res.nextCursor !== "" ? res.nextCursor : null;
			threadNextCursorsRef.current[tid] = nxt;
			if (activeThreadIdRef.current === tid) setThreadHasMore(nxt !== null);
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

	// Retry a page that was skipped while offline. Depends on threadHasMore so
	// it only arms while there is history left.
	useEffect(() => {
		if (!threadHasMore || activeThreadId === null) return;
		if (typeof window === "undefined") return;
		const onOnline = () => {
			void loadMoreThreadMessages();
		};
		window.addEventListener("online", onOnline);
		return () => window.removeEventListener("online", onOnline);
	}, [threadHasMore, activeThreadId, loadMoreThreadMessages]);

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
	};
}
