import { useEffect, useState } from "react";
import { chatsRepo } from "../db/chatsRepo.ts";
import { getActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import {
	getMyKeyPair,
	hasLocalLock,
	isLocalLockUnlocked,
} from "../e2ee/keys.ts";
import { onLocalLockChanged } from "../e2ee/localLock.ts";
import { decryptMessage } from "../e2ee/message.ts";
import type { Message } from "../types/api.ts";
import { chatTitle } from "../utils/chat.ts";
import { useLocalLockRevision } from "./useLocalLockRevision.ts";

const MIN_QUERY = 2;
const MAX_RESULTS = 50;

export interface MessageSearchResult {
	chatId: string;
	chatTitle: string;
	message: Message;
}

interface ResultsSnapshot {
	// Results belong to the account they were decrypted for. A snapshot of
	// another account (or of a session that has ended since) is never shown:
	// the local search reads plaintext from the whole account database.
	userId: string | undefined;
	results: MessageSearchResult[];
}

const EMPTY_SNAPSHOT: ResultsSnapshot = { userId: undefined, results: [] };

export function useLocalMessageSearch(userId: string | undefined) {
	const [query, setQuery] = useState("");
	const [snapshot, setSnapshot] = useState<ResultsSnapshot>(EMPTY_SNAPSHOT);
	const [loading, setLoading] = useState(false);
	const lockRevision = useLocalLockRevision();

	useEffect(() => onLocalLockChanged(() => setSnapshot(EMPTY_SNAPSHOT)), []);

	useEffect(() => {
		// Re-run and drop results when the local lock changes.
		void lockRevision;
		const trimmed = query.trim().toLowerCase();
		// The active account is the only database this search may read: after
		// a switch the prop and the database key disagree for a moment.
		const accountKey = getActiveAccountKey();
		const forActiveAccount =
			userId !== undefined && accountKey !== null && accountKey === userId;
		if (
			trimmed.length < MIN_QUERY ||
			userId === undefined ||
			!forActiveAccount
		) {
			setSnapshot(EMPTY_SNAPSHOT);
			setLoading(false);
			return;
		}

		const ownerId = userId;
		let cancelled = false;
		setLoading(true);
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const [chats, stored] = await Promise.all([
						chatsRepo.getAll(),
						messagesRepo.getAll(),
					]);
					if (cancelled || getActiveAccountKey() !== ownerId) return;
					const titles = new Map(
						chats.map((chat) => [chat.id, chatTitle(chat, ownerId)]),
					);
					const key = await getMyKeyPair();
					if (cancelled || getActiveAccountKey() !== ownerId) return;
					if ((await hasLocalLock()) && !isLocalLockUnlocked()) return;
					const out: MessageSearchResult[] = [];
					for (const row of stored) {
						if (cancelled || getActiveAccountKey() !== ownerId) return;
						if (row.status === "deleted") continue;
						const message = await decryptMessage(row, ownerId, key);
						if (message.undecryptable === true) continue;
						if (!message.text.toLowerCase().includes(trimmed)) continue;
						out.push({
							chatId: message.chatId,
							chatTitle: titles.get(message.chatId) ?? message.chatId,
							message,
						});
						if (out.length >= MAX_RESULTS) break;
					}
					if (cancelled || getActiveAccountKey() !== ownerId) return;
					if ((await hasLocalLock()) && !isLocalLockUnlocked()) return;
					setSnapshot({ userId: ownerId, results: out });
				} catch {
					if (!cancelled) setSnapshot(EMPTY_SNAPSHOT);
				} finally {
					if (!cancelled) setLoading(false);
				}
			})();
		}, 250);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, userId, lockRevision]);

	// A snapshot of another account is not shown even before the new search
	// finishes: the previous account's plaintext must not survive the switch.
	const results = snapshot.userId === userId ? snapshot.results : [];

	return { query, setQuery, results, loading };
}
