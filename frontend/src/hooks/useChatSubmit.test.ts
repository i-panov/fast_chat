import { renderHook } from "@testing-library/react";
import type { FormEvent } from "react";
import type { Chat } from "../types/api.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";

vi.mock("../api.ts", () => ({
	createChat: vi.fn(),
}));

const { createChat } = await import("../api.ts");
const { useChatSubmit } = await import("./useChatSubmit.ts");

function event() {
	return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
}

function deps(overrides: Record<string, unknown> = {}) {
	return {
		token: "tok",
		user: { id: "alice:test" },
		inputText: "hello",
		pendingFiles: [],
		pendingLocation: null,
		editingMessage: null,
		pendingChatWith: null,
		activeChatId: "c1",
		activeThreadId: null,
		replyToMessage: null,
		sendMessage: vi.fn(async (_o: unknown) => {}),
		editMessage: vi.fn(async (_o: unknown) => {}),
		selectChat: vi.fn(),
		closeThread: vi.fn(),
		clearAllPendingFiles: vi.fn(),
		clearEditing: vi.fn(),
		clearPendingChat: vi.fn(),
		clearReply: vi.fn(),
		clearPendingLocation: vi.fn(),
		setInputText: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
});

describe("useChatSubmit", () => {
	it("sends to the active chat and resets the form", async () => {
		const d = deps({
			replyToMessage: {
				chatId: "c1",
				messageId: "m1",
				fromNick: "b",
				text: "t",
			},
			activeThreadId: "th1",
		});
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.sendMessage).toHaveBeenCalledWith({
			chatId: "c1",
			text: "hello",
			pendingFiles: undefined,
			location: undefined,
			replyToId: "m1",
			threadId: "th1",
		});
		expect(d.setInputText).toHaveBeenCalledWith("");
		expect(d.clearAllPendingFiles).toHaveBeenCalled();
		expect(d.clearReply).toHaveBeenCalled();
		expect(d.clearPendingLocation).toHaveBeenCalled();
	});

	it("does nothing without a token or user", async () => {
		for (const d of [deps({ token: undefined }), deps({ user: null })]) {
			const { result, unmount } = renderHook(() => useChatSubmit(d));

			await result.current(event());

			expect(d.sendMessage).not.toHaveBeenCalled();
			expect(d.setInputText).not.toHaveBeenCalled();
			unmount();
		}
	});

	it("does nothing on empty input", async () => {
		const d = deps({ inputText: "   " });
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.sendMessage).not.toHaveBeenCalled();
		expect(d.setInputText).not.toHaveBeenCalled();
	});

	it("edits the message and clears the editor", async () => {
		const d = deps({
			inputText: "fixed",
			editingMessage: {
				chatId: "c1",
				messageId: "m1",
				text: "old",
				location: { lat: 1, lng: 2 },
			},
		});
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.editMessage).toHaveBeenCalledWith({
			chatId: "c1",
			messageId: "m1",
			text: "fixed",
			pendingFiles: undefined,
			location: { lat: 1, lng: 2 },
			clearLocation: false,
			threadId: undefined,
		});
		expect(d.clearEditing).toHaveBeenCalled();
		expect(d.sendMessage).not.toHaveBeenCalled();
	});

	it("clears the location when editing removed it", async () => {
		const d = deps({
			inputText: "fixed",
			editingMessage: {
				chatId: "c1",
				messageId: "m1",
				text: "old",
				location: null,
			},
		});
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.editMessage).toHaveBeenCalledWith(
			expect.objectContaining({ location: null, clearLocation: true }),
		);
	});

	it("creates a pending private chat before sending", async () => {
		const newChat: Chat = {
			id: "c-new",
			type: "private",
			name: "bob",
			ownerId: "alice:test",
			members: [],
			createdAt: "2026-01-01T00:00:00Z",
		};
		vi.mocked(createChat).mockResolvedValueOnce({ chat: newChat });
		const d = deps({ pendingChatWith: "bob:test", activeChatId: null });
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(createChat).toHaveBeenCalledWith("tok", {
			type: "private",
			withUserId: "bob:test",
		});
		expect(await chatsRepo.getById("c-new")).toBeTruthy();
		expect(d.selectChat).toHaveBeenCalledWith("c-new");
		expect(d.closeThread).toHaveBeenCalled();
		expect(d.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ chatId: "c-new", text: "hello" }),
		);
		expect(d.clearPendingChat).toHaveBeenCalled();
	});

	it("ignores a thread-only submit", async () => {
		const d = deps({ activeChatId: null, activeThreadId: "th1" });
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.sendMessage).not.toHaveBeenCalled();
		expect(d.setInputText).not.toHaveBeenCalled();
	});
});
