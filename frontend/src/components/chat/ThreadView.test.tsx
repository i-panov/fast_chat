import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatContext from "../../context/ChatContext.tsx";
import type { ChatPageState } from "../../types/chat.ts";
import { ThreadView } from "./ThreadView.tsx";

const mlPropsHolder: { current: Record<string, never> } = { current: {} };
const inputBarPropsHolder: { current: Record<string, never> } = { current: {} };

vi.mock("./MessageList.tsx", () => ({
	MessageList: (props: Record<string, unknown>) => {
		mlPropsHolder.current = props as Record<string, never>;
		return <div data-testid="message-list" />;
	},
}));

vi.mock("./InputBar.tsx", () => ({
	InputBar: (props: Record<string, unknown>) => {
		inputBarPropsHolder.current = props as Record<string, never>;
		return <div data-testid="input-bar" />;
	},
}));

function state(overrides: Partial<ChatPageState> = {}): ChatPageState {
	return {
		activeAccount: null,
		user: { id: "alice:test", nick: "alice" },
		logout: () => {},
		switcherOpen: false,
		setSwitcherOpen: () => {},
		chats: [],
		activeChatId: "c1",
		activeChat: undefined,
		selectChat: () => {},
		activeMessages: [],
		hasMore: false,
		isLoadingMore: false,
		loadMoreMessages: () => Promise.resolve(),
		threads: {},
		messageToThread: {},
		activeThreadId: "th1",
		activeThread: {
			id: "th1",
			chatId: "c1",
			parentMessageId: "p1",
			parentMessageText: "parent text",
			parentMessageFrom: "bob",
			createdAt: "2026-01-01T00:00:00Z",
			messageCount: 1,
		},
		activeThreadMessages: [],
		threadHasMore: false,
		threadIsLoadingMore: false,
		handleOpenThread: () => {},
		handleCloseThread: () => {},
		loadMoreThreadMessages: () => Promise.resolve(),
		handleCreateThread: () => Promise.resolve(),
		typingUsers: {},
		handleTyping: () => {},
		pendingFiles: [],
		handleAttachFiles: () => Promise.resolve(),
		handleRemoveFile: () => {},
		config: null,
		searchQuery: "",
		searchResults: [],
		showSearchResults: false,
		handleSearchChange: () => {},
		pendingChatWith: null,
		pendingChatNick: null,
		selectPendingChat: () => {},
		inputText: "",
		setInputText: () => {},
		handleSend: () => Promise.resolve(),
		handleSendThreadMessage: () => Promise.resolve(),
		handleDeleteMessage: () => {},
		editingMessage: null,
		handleStartEdit: () => {},
		handleCancelEdit: () => {},
		handleRemoveExistingFile: () => {},
		handleRemoveExistingLocation: () => {},
		replyToMessage: null,
		handleReply: () => {},
		cancelReply: () => {},
		handleRetryMessage: () => Promise.resolve(),
		handleCancelSendMessage: () => Promise.resolve(),
		handleDeleteThreadMessage: () => {},
		handleRetryThreadMessage: () => Promise.resolve(),
		pendingLocation: null,
		locationPickerOpen: false,
		setLocationPickerOpen: () => {},
		openLocationPicker: () => {},
		handleLocationConfirm: () => {},
		clearPendingLocation: () => {},
		createGroupOpen: false,
		setCreateGroupOpen: () => {},
		handleCreateGroup: () => Promise.resolve(),
		groupSettingsChatId: null,
		groupSettings: null,
		openGroupSettings: () => Promise.resolve(),
		closeGroupSettings: () => {},
		handleRenameGroup: () => Promise.resolve(),
		handleAddGroupMember: () => Promise.resolve(),
		handleRemoveGroupMember: () => Promise.resolve(),
		handleDeleteGroup: () => Promise.resolve(),
		handleUploadGroupAvatar: () => Promise.resolve(),
		isOnline: true,
		syncState: "idle",
		...overrides,
	};
}

function renderView(value: ChatPageState) {
	return render(
		<MantineProvider>
			<ChatContext.Provider value={value}>
				<ThreadView />
			</ChatContext.Provider>
		</MantineProvider>,
	);
}

describe("ThreadView", () => {
	it("renders nothing without an active thread", () => {
		const { container } = renderView(state({ activeThread: null }));

		expect(container.querySelector('[data-testid="message-list"]')).toBeNull();
	});

	it("shows the parent header and closes", () => {
		const handleCloseThread = vi.fn();
		renderView(state({ handleCloseThread }));

		expect(screen.getByText("parent text")).toBeTruthy();
		expect(screen.getByText("bob")).toBeTruthy();

		const buttons = [...document.querySelectorAll("button")];
		fireEvent.click(buttons[0]);

		expect(handleCloseThread).toHaveBeenCalledTimes(1);
	});

	it("routes message actions through the thread", async () => {
		const handleDeleteThreadMessage = vi.fn();
		const handleCancelSendMessage = vi.fn(
			async (_c: string, _m: string, _t?: string) => {},
		);
		const handleRetryThreadMessage = vi.fn(
			async (_t: string, _m: string) => {},
		);
		const loadMoreThreadMessages = vi.fn(async () => {});
		renderView(
			state({
				handleDeleteThreadMessage,
				handleCancelSendMessage,
				handleRetryThreadMessage,
				loadMoreThreadMessages,
			}),
		);

		const ml = mlPropsHolder.current as unknown as {
			onDelete: (chatId: string, messageId: string) => void;
			onCancelSend: (chatId: string, messageId: string) => void;
			onRetry: (chatId: string, messageId: string) => Promise<void>;
			onLoadMore: () => void;
		};
		ml.onDelete("c1", "m1");
		expect(handleDeleteThreadMessage).toHaveBeenCalledWith("th1", "m1");

		ml.onCancelSend("c1", "m2");
		expect(handleCancelSendMessage).toHaveBeenCalledWith("c1", "m2", "th1");

		await ml.onRetry("c1", "m3");
		expect(handleRetryThreadMessage).toHaveBeenCalledWith("th1", "m3");

		ml.onLoadMore();
		expect(loadMoreThreadMessages).toHaveBeenCalledTimes(1);
	});

	it("forwards the input bar submit", () => {
		const handleSendThreadMessage = vi.fn(async (_e: unknown) => {});
		renderView(state({ handleSendThreadMessage }));

		const bar = inputBarPropsHolder.current as unknown as {
			onSubmit: (e: unknown) => void;
		};
		bar.onSubmit({ preventDefault: () => {} });

		expect(handleSendThreadMessage).toHaveBeenCalledTimes(1);
	});
});
