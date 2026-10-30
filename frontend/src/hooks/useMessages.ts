import { useCallback, useEffect, useRef, useState } from "react";
import { getMessages } from "../api.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { StoredMessage } from "../db/schema.ts";
import { useLiveQuery } from "../db/useLiveQuery.ts";
import { getMyKeyPair } from "../e2ee/keys.ts";
import { decryptMessage } from "../e2ee/message.ts";
import i18n from "../i18n.ts";
import type { Message, MessageStatus } from "../types/api.ts";
import { useAuth } from "../useAuth.tsx";
import { stripMeta } from "../utils/helpers.ts";
import { emitNotification } from "../utils/notify.ts";

interface MessageWithStatus extends Message {
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

// Bound the decrypt cache so long-lived chats with many edits do not
// grow it forever; the oldest entries (insertion order) are evicted first.
const DECRYPT_CACHE_MAX = 1000;

function evictDecryptCache(cache: Map<string, MessageWithStatus>): void {
	while (cache.size > DECRYPT_CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

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

	// Cursors and in-flight flags are keyed by account+chat so two chats (or
	// two accounts sharing a chat id) never block or reuse each other's
	// pagination state.
	const nextCursorsRef = useRef<Record<string, string | null>>({});
	const loadingMoreRef = useRef<Set<string>>(new Set());

	const query = useCallback(() => {
		if (chatId === null) return Promise.resolve([] as StoredMessage[]);
		return messagesRepo.getByChat(chatId);
	}, [chatId]);
	const stored = useLiveQuery<StoredMessage[]>(query);

	const { activeAccount } = useAuth();
	const userId = activeAccount?.user.id;

	// Decrypt E2E ciphertext at the render boundary; the cache keeps the
	// ciphertext untouched. Decryptions are cached per message revision so
	// large histories are not re-decrypted on every DB change, and the
	// result array keeps a stable reference while contents are unchanged
	// so unrelated notify() cycles do not re-render the message list.
	const [visible, setVisible] = useState<MessageWithStatus[]>([]);
	const decryptCacheRef = useRef<Map<string, MessageWithStatus>>(new Map());
	// Revision index: message id → cache keys of its known revisions, so
	// dropping a superseded revision is O(1) instead of scanning the whole
	// cache for every inserted message.
	const decryptRevisionsRef = useRef<Map<string, Set<string>>>(new Map());
	const cacheOwnerRef = useRef<string | undefined>(undefined);
	const lastVisibleRef = useRef<{
		key: string;
		value: MessageWithStatus[];
	} | null>(null);

	useEffect(() => {
		let alive = true;

		void (async () => {
			if (cacheOwnerRef.current !== userId) {
				cacheOwnerRef.current = userId;
				decryptCacheRef.current.clear();
				decryptRevisionsRef.current.clear();
			}

			const signature = (stored ?? [])
				.map((s) => `${s.id}:${s.status}:${s._updatedAt}`)
				.join("|");
			const prev = lastVisibleRef.current;
			if (prev !== null && prev.key === signature) {
				if (alive) setVisible(prev.value);
				return;
			}

			const key = await getMyKeyPair();
			const out: MessageWithStatus[] = [];

			for (const sm of stored ?? []) {
				if (sm.status === "deleted") continue;

				const cacheKey = `${sm.id}:${sm._updatedAt}:${sm.status}`;
				const cached = decryptCacheRef.current.get(cacheKey);
				if (cached !== undefined && !cached.undecryptable) {
					out.push(cached);
					continue;
				}

				const decrypted =
					userId !== undefined ? await decryptMessage(sm, userId, key) : sm;
				const client = toClientMessage({ ...sm, ...decrypted });
				decryptCacheRef.current.set(cacheKey, client);
				// Drop stale revisions of the same message so old plaintext
				// does not linger in memory until the generic eviction.
				let revs = decryptRevisionsRef.current.get(sm.id);
				if (revs === undefined) {
					// Bound the index itself: worst case a stale revision
					// waits for the generic size eviction, as before.
					if (decryptRevisionsRef.current.size > DECRYPT_CACHE_MAX * 2) {
						decryptRevisionsRef.current.clear();
					}
					revs = new Set();
					decryptRevisionsRef.current.set(sm.id, revs);
				} else {
					for (const k of revs) {
						if (k !== cacheKey) {
							decryptCacheRef.current.delete(k);
							revs.delete(k);
						}
					}
				}
				revs.add(cacheKey);
				evictDecryptCache(decryptCacheRef.current);
				out.push(client);
			}

			lastVisibleRef.current = { key: signature, value: out };
			if (alive) setVisible(out);
		})();

		return () => {
			alive = false;
		};
	}, [stored, userId]);
	const loadMore = useCallback(async () => {
		if (chatId === null || token === undefined) return;
		const cursorKey = `${userId ?? ""}:${chatId}`;
		if (loadingMoreRef.current.has(cursorKey)) return;

		const cursor = nextCursorsRef.current[cursorKey] ?? null;
		if (cursor === null && nextCursorsRef.current[cursorKey] !== undefined)
			return;

		if (typeof navigator !== "undefined" && !navigator.onLine) {
			setHasMore(false);
			return;
		}

		loadingMoreRef.current.add(cursorKey);
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
			nextCursorsRef.current[cursorKey] = nxt;
			setHasMore(nxt !== null);
		} catch {
			emitNotification(i18n.t("error.loadMessages"));
		} finally {
			setIsLoadingMore(false);
			loadingMoreRef.current.delete(cursorKey);
		}
	}, [chatId, token, userId]);

	useEffect(() => {
		if (chatId === null || token === undefined) {
			setHasMore(false);
			return;
		}
		const cursorKey = `${userId ?? ""}:${chatId}`;
		if (nextCursorsRef.current[cursorKey] === undefined) {
			void loadMore();
		} else {
			setHasMore(nextCursorsRef.current[cursorKey] !== null);
		}
	}, [chatId, token, userId, loadMore]);

	return {
		messages: visible,
		hasMore,
		isLoadingMore,
		loadMore,
	};
}
