import { createContext, useContext } from "react";

export interface MessageSelection {
	mode: boolean;
	selected: ReadonlySet<string>;
	toggle: (messageId: string) => void;
	start: (messageId: string) => void;
	clear: () => void;
}

const MessageSelectionContext = createContext<MessageSelection | null>(null);

export const MessageSelectionProvider = MessageSelectionContext.Provider;

export function useMessageSelection(): MessageSelection | null {
	return useContext(MessageSelectionContext);
}
