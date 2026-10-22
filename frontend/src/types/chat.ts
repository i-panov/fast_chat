import type { CallView } from "../calls/callTypes.ts";
import type {
	Chat,
	FileInfo,
	Location,
	Message,
	PendingFile,
	Thread,
	TypingPayload,
	User,
} from "./api.ts";

export interface EditingMessage {
	chatId: string;
	messageId: string;
	text: string;
	files?: FileInfo[];
	threadId?: string;
	location?: Location | null;
}

export interface ReplyTarget {
	chatId: string;
	messageId: string;
	fromNick: string;
	text: string;
	files?: FileInfo[];
}

export interface ChatPageState {
	activeAccount: { token: string; user: { id: string; nick: string } } | null;
	user: { id: string; nick: string } | null;
	logout: () => void;

	switcherOpen: boolean;
	setSwitcherOpen: (open: boolean) => void;

	chats: Chat[];
	activeChatId: string | null;
	activeChat: Chat | undefined;
	selectChat: (chatId: string | null) => void;

	activeMessages: Array<Message & { status: "sent" | "queued" | "failed" }>;
	hasMore: boolean;
	isLoadingMore: boolean;
	loadMoreMessages: (chatId: string | null) => Promise<void>;

	threads: Record<string, Thread>;
	messageToThread: Record<string, string>;
	activeThreadId: string | null;
	activeThread: Thread | null;
	activeThreadMessages: Message[];
	threadHasMore: boolean;
	threadIsLoadingMore: boolean;
	handleOpenThread: (threadId: string) => void;
	handleCloseThread: () => void;
	loadMoreThreadMessages: () => Promise<void>;
	handleCreateThread: (chatId: string, messageId: string) => Promise<void>;

	typingUsers: Record<string, TypingPayload[]>;
	handleTyping: (chatId: string, active: boolean) => void;

	pendingFiles: PendingFile[];
	handleAttachFiles: (files: File[]) => void | Promise<void>;
	handleRemoveFile: (id: string) => void;

	config: { messageEditTTL: number; messageDeleteTTL: number } | null;

	searchQuery: string;
	searchResults: User[];
	showSearchResults: boolean;
	handleSearchChange: (value: string) => void;

	pendingChatWith: string | null;
	pendingChatNick: string | null;
	selectPendingChat: (withUserId: string, withUserNick: string) => void;

	inputText: string;
	setInputText: (v: string) => void;

	handleSend: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
	handleSendThreadMessage: (
		e: React.FormEvent<HTMLFormElement>,
	) => Promise<void>;

	handleDeleteMessage: (
		chatId: string,
		messageId: string,
	) => void | Promise<void>;

	editingMessage: EditingMessage | null;
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

	replyToMessage: ReplyTarget | null;
	handleReply: (chatId: string, messageId: string) => void;
	cancelReply: () => void;

	handleRetryMessage: (chatId: string, messageId: string) => Promise<void>;
	handleCancelSendMessage: (
		chatId: string,
		messageId: string,
		threadId?: string,
	) => Promise<void>;
	handleDeleteThreadMessage: (threadId: string, messageId: string) => void;
	handleRetryThreadMessage: (
		threadId: string,
		messageId: string,
	) => Promise<void>;

	pendingLocation: Location | null;
	locationPickerOpen: boolean;
	setLocationPickerOpen: (v: boolean) => void;
	openLocationPicker: () => void;
	handleLocationConfirm: (loc: Location) => void;
	clearPendingLocation: () => void;

	createGroupOpen: boolean;
	setCreateGroupOpen: (v: boolean) => void;
	handleCreateGroup: (name: string, memberIds: string[]) => Promise<void>;
	groupSettingsChatId: string | null;
	groupSettings: Chat | null;
	openGroupSettings: (chatId: string) => Promise<void>;
	closeGroupSettings: () => void;
	handleRenameGroup: (name: string) => Promise<void>;
	handleAddGroupMember: (userId: string) => Promise<void>;
	handleRemoveGroupMember: (userId: string) => Promise<void>;
	handleDeleteGroup: () => Promise<void>;
	handleUploadGroupAvatar: (file: File) => Promise<void>;

	isOnline: boolean;
	syncState: "idle" | "syncing" | "error";

	call: CallView;
	startCall: (chatId: string) => Promise<void>;
	acceptCall: () => Promise<void>;
	rejectCall: () => Promise<void>;
	hangupCall: () => Promise<void>;
	toggleCallMute: () => void;
	toggleCallCamera: () => void;
	dismissCall: () => void;
}
