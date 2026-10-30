import { useCallback, useEffect, useState } from "react";
import { chatsRepo } from "../db/chatsRepo.ts";
import type { StoredChat } from "../db/schema.ts";
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

export function useChatList({ token }: UseChatListParams): UseChatListReturn {
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const query = useCallback(() => chatsRepo.getAll(), []);
	const storedChats = useLiveQuery<StoredChat[]>(query);

	useEffect(() => {
		if (token === undefined) return;
		scheduleSync();
	}, [token]);

	const chats = storedChats?.map(stripMeta) ?? [];
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
