import { useCallback, useEffect, useState } from "react";
import type { Chat } from "../api.ts";
import { getChats } from "../api.ts";
import i18n from "../i18n.ts";
import { emitNotification } from "../utils/notify.ts";

interface UseChatListParams {
	token: string | undefined;
}

interface UseChatListReturn {
	chats: Chat[];
	setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
	activeChatId: string | null;
	activeChat: Chat | undefined;
	selectChat: (chatId: string) => void;
}

export function useChatList({ token }: UseChatListParams): UseChatListReturn {
	const [chats, setChats] = useState<Chat[]>([]);
	const [activeChatId, setActiveChatId] = useState<string | null>(null);

	const loadChats = useCallback(async () => {
		if (!token) return;

		try {
			const { chats: fetchedChats } = await getChats(token);
			setChats(fetchedChats);
		} catch {
			emitNotification(i18n.t("error.loadChats"));
		}
	}, [token]);

	useEffect(() => {
		if (!token) {
			setChats([]);
			return;
		}

		loadChats();
	}, [token, loadChats]);

	const selectChat = useCallback((chatId: string) => {
		setActiveChatId(chatId);
	}, []);

	const activeChat = chats.find((c) => c.id === activeChatId);

	return {
		chats,
		setChats,
		activeChatId,
		activeChat,
		selectChat,
	};
}
