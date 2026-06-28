import { createContext, type ReactNode, useContext } from "react";
import type {
	AppConfig,
	Chat,
	FileInfo,
	Location,
	Message,
	Thread,
	TypingPayload,
} from "../api.ts";

interface EditingMessage {
	chatId: string;
	messageId: string;
	text: string;
	files?: FileInfo[];
	threadId?: string;
	location?: Location | null;
}

interface ReplyTarget {
	chatId: string;
	messageId: string;
	fromNick: string;
	text: string;
	files?: FileInfo[];
}

interface ChatPageContextValue {
	// Состояние
	activeChatId: string | null;
	activeChat: Chat | undefined;
	activeMessages: Message[];
	config: AppConfig | null;
	editingMessage: EditingMessage | null;
	replyToMessage: ReplyTarget | null;
	pendingLocation: Location | null;
	activeThreadId: string | null;
	activeThread: Thread | null;
	activeThreadMessages: Message[];
	threads: Record<string, Thread>;
	messageToThread: Record<string, string>;
	typingUsers: Record<string, TypingPayload[]>;
	hasMore: boolean;
	isLoadingMore: boolean;
	threadHasMore: boolean;
	threadIsLoadingMore: boolean;
	groupSettingsChatId: string | null;
	groupSettings: Chat | null;
	createGroupOpen: boolean;
	locationPickerOpen: boolean;
	pendingChatWith: string | null;
	pendingChatNick: string | null;

	// Действия
	selectChat: (chatId: string | null) => void;
	selectPendingChat: (withUserId: string, withUserNick: string) => void;
	setInputText: (v: string) => void;
	handleSend: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
	handleSendThreadMessage: (
		e: React.FormEvent<HTMLFormElement>,
	) => Promise<void>;
	handleDeleteMessage: (chatId: string, messageId: string) => void;
	handleStartEdit: (
		chatId: string,
		messageId: string,
		text: string,
		files?: FileInfo[],
		threadId?: string,
	) => void;
	handleCancelEdit: () => void;
	handleRemoveExistingFile: (fileId: string) => void;
	handleRemoveExistingLocation: () => void;
	handleAttachFiles: (files: File[]) => void;
	handleRemoveFile: (fileId: string) => void;
	openLocationPicker: () => void;
	handleLocationConfirm: (loc: Location) => void;
	handleRemovePendingLocation: () => void;
	createThread: (chatId: string, messageId: string) => Promise<void>;
	openThread: (threadId: string) => void;
	closeThread: () => void;
	loadMoreMessages: () => Promise<void>;
	loadMoreThreadMessages: () => Promise<void>;
	handleTyping: (chatId: string, active: boolean) => void;
	handleRenameGroup: (name: string) => Promise<void>;
	handleAddGroupMember: (userId: string) => Promise<void>;
	handleRemoveGroupMember: (userId: string) => Promise<void>;
	handleDeleteGroup: () => Promise<void>;
	handleUploadGroupAvatar: (file: File) => Promise<void>;
	openGroupSettings: (chatId: string) => Promise<void>;
	closeGroupSettings: () => void;
	setCreateGroupOpen: (v: boolean) => void;
	handleCreateGroup: (name: string, memberIds: string[]) => Promise<void>;
	setLocationPickerOpen: (v: boolean) => void;
}

const ChatPageContext = createContext<ChatPageContextValue | null>(null);

export function ChatPageProvider({
	children,
	value,
}: {
	children: ReactNode;
	value: ChatPageContextValue;
}) {
	return (
		<ChatPageContext.Provider value={value}>
			{children}
		</ChatPageContext.Provider>
	);
}

export function useChatPageContext(): ChatPageContextValue {
	const ctx = useContext(ChatPageContext);
	if (!ctx) {
		throw new Error("useChatPageContext must be used within ChatPageProvider");
	}
	return ctx;
}

export type { EditingMessage, ReplyTarget };
