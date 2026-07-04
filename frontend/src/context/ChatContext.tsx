import { createContext, useContext } from "react";
import type { ChatPageState } from "../types/chat.ts";

const ChatContext = createContext<ChatPageState | null>(null);

export function useChatContext(): ChatPageState {
	const ctx = useContext(ChatContext);
	if (ctx === null) {
		throw new Error("useChatContext must be used within ChatPage");
	}
	return ctx;
}

export default ChatContext;
