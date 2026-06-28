import { useCallback, useEffect, useState } from "react";
import type { Chat } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import type { StoredChat } from "../db/schema.ts";
import { useLiveQuery } from "../db/useLiveQuery.ts";
import { scheduleSync } from "../sync/syncEngine.ts";

interface UseChatListParams {
	token: string | undefined;
}

interface UseChatListReturn {
	chats: Chat[];
	activeChatId: string | null;
	activeChat: Chat | undefined;
	selectChat: (chatId: string | null) => void;
}

function stripMetadata(sc: StoredChat): Chat {
	const { _updatedAt: _u, ...rest } = sc;
	void _u;
	return rest;
}

export function useChatList({ token }: UseChatListParams): UseChatListReturn {
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const query = useCallback(() => chatsRepo.getAll(), []);
	const storedChats = useLiveQuery<StoredChat[]>(query);

	useEffect(() => {
		if (token === undefined) return;
		scheduleSync();
	}, [token]);

	const chats = storedChats?.map(stripMetadata) ?? [];
	const activeChat = chats.find((c) => c.id === activeChatId);

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
