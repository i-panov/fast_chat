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
	activeChatId: string | null;
	activeChat: Chat | undefined;
	isLoading: boolean;
	selectChat: (chatId: string) => void;
	refreshChats: () => Promise<void>;
}

export function useChatList({ token }: UseChatListParams): UseChatListReturn {
	const [chats, setChats] = useState<Chat[]>([]);
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	const loadChats = useCallback(async () => {
		if (!token) return;

		setIsLoading(true);
		try {
			const { chats: fetchedChats } = await getChats(token);
			setChats(fetchedChats);
		} catch {
			emitNotification(i18n.t("error.loadChats"));
		} finally {
			setIsLoading(false);
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

	const refreshChats = useCallback(async () => {
		await loadChats();
	}, [loadChats]);

	const activeChat = chats.find((c) => c.id === activeChatId);

	return {
		chats,
		activeChatId,
		activeChat,
		isLoading,
		selectChat,
		refreshChats,
	};
}
