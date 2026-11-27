import { useCallback, useEffect, useState } from "react";
import { chatsRepo } from "../db/chatsRepo.ts";
import { getActiveAccountKey } from "../db/init.ts";
import { useLiveQuery } from "../db/useLiveQuery.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import type { Chat } from "../types/api.ts";
import { stripMeta } from "../utils/helpers.ts";

interface UseChatListParams {
	token: string | undefined;
}

interface UseChatListReturn {
	chats: Chat[];
	activeChatId: string | null;
	activeChat: Chat | undefined;
	selectChat: (chatId: string | null) => void;
}

interface ChatsSnapshot {
	// The account the rows were read from. The live query re-reads
	// asynchronously after a switch, and rendering the previous account's
	// chat titles in the meantime would leak them.
	accountKey: string | null;
	chats: Chat[];
}

export function useChatList({ token }: UseChatListParams): UseChatListReturn {
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const query = useCallback(async (): Promise<ChatsSnapshot> => {
		const accountKey = getActiveAccountKey();
		const rows = await chatsRepo.getAll();
		return { accountKey, chats: rows.map(stripMeta) };
	}, []);
	const stored = useLiveQuery<ChatsSnapshot>(query);

	useEffect(() => {
		if (token === undefined) return;
		scheduleSync();
	}, [token]);

	const accountKey = getActiveAccountKey();
	// A snapshot of another account (or of the pre-account database) is not
	// shown at all until the re-read for the current one lands.
	const chats =
		stored !== undefined && stored.accountKey === accountKey
			? stored.chats
			: [];
	const activeChat = chats.find((c) => c.id === activeChatId);

	// A chat selected under another account must not stay selected after
	// switching accounts; the new account's chat list may not contain it.
	// Reset in an effect (not during render) to avoid setState-in-render.
	useEffect(() => {
		if (activeChat === undefined && activeChatId !== null) {
			setActiveChatId(null);
		}
	}, [activeChat, activeChatId]);

	const selectChat = useCallback((chatId: string | null) => {
		setActiveChatId(chatId);
	}, []);

	return {
		chats,
		activeChatId,
		activeChat,
		selectChat,
	};
}
