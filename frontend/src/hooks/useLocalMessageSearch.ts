import { useEffect, useState } from "react";
import { chatsRepo } from "../db/chatsRepo.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { getMyKeyPair } from "../e2ee/keys.ts";
import { decryptMessage } from "../e2ee/message.ts";
import type { Message } from "../types/api.ts";
import { chatTitle } from "../utils/chat.ts";

const MIN_QUERY = 2;
const MAX_RESULTS = 50;

export interface MessageSearchResult {
	chatId: string;
	chatTitle: string;
	message: Message;
}

export function useLocalMessageSearch(userId: string | undefined) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<MessageSearchResult[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		const trimmed = query.trim().toLowerCase();
		if (trimmed.length < MIN_QUERY || userId === undefined) {
			setResults([]);
			setLoading(false);
			return;
		}

		let cancelled = false;
		setLoading(true);
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const [chats, stored] = await Promise.all([
						chatsRepo.getAll(),
						messagesRepo.getAll(),
					]);
					if (cancelled) return;
					const titles = new Map(
						chats.map((chat) => [chat.id, chatTitle(chat, userId)]),
					);
					const key = await getMyKeyPair();
					const out: MessageSearchResult[] = [];
					for (const row of stored) {
						if (row.status === "deleted") continue;
						const message = await decryptMessage(row, userId, key);
						if (message.undecryptable === true) continue;
						if (!message.text.toLowerCase().includes(trimmed)) continue;
						out.push({
							chatId: message.chatId,
							chatTitle: titles.get(message.chatId) ?? message.chatId,
							message,
						});
						if (out.length >= MAX_RESULTS) break;
					}
					if (!cancelled) setResults(out);
				} finally {
					if (!cancelled) setLoading(false);
				}
			})();
		}, 250);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, userId]);

	return { query, setQuery, results, loading };
}
