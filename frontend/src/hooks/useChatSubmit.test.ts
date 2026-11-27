import { renderHook } from "@testing-library/react";
import type { FormEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import type { Chat, PendingFile } from "../types/api.ts";

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
		pendingFiles: [] as PendingFile[],
		pendingLocation: null,
		editingMessage: null,
		pendingChatWith: null,
		activeChatId: "c1",
		activeThreadId: null,
		replyToMessage: null,
		sendMessage: vi.fn(
			(_o: unknown): Promise<undefined> => Promise.resolve(undefined),
		),
		editMessage: vi.fn(
			(_o: unknown): Promise<undefined> => Promise.resolve(undefined),
		),
		selectChat: vi.fn(),
		closeThread: vi.fn(),
		removePendingFiles: vi.fn(),
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
	it("ignores a second submit while the first is in flight", async () => {
		// Two submits would reuse the same pending files: one preview URL for
		// two rows and one staged blob consumed twice.
		const pending: Array<(ok: boolean) => void> = [];
		const sendMessage = vi.fn(
			(_o: unknown) =>
				new Promise<boolean | undefined>((resolve) => {
					pending.push(resolve);
				}),
		);
		const d = deps({ sendMessage });
		const { result } = renderHook(() => useChatSubmit(d));

		const first = result.current(event());
		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		// Not awaited: without the guard this submit would block on the same
		// in-flight send, so the assertion below must fail fast instead.
		void result.current(event());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sendMessage).toHaveBeenCalledTimes(1);

		pending[0]?.(true);
		await first;

		const third = result.current(event());
		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});
		pending[1]?.(true);
		await third;
	});

	it("sends to the active chat and resets the form", async () => {
		const pendingFile = {
			id: "f1",
			file: new File(["x"], "a.txt", { type: "text/plain" }),
			blobUrl: "blob:x",
			originalName: "a.txt",
			size: 1,
			mimeType: "text/plain",
			fileType: "file" as const,
			encrypted: true,
		};
		const d = deps({
			pendingFiles: [pendingFile],
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
			pendingFiles: [pendingFile],
			location: undefined,
			replyToId: "m1",
			threadId: "th1",
		});
		expect(d.setInputText).toHaveBeenCalledWith("");
		expect(d.removePendingFiles).toHaveBeenCalledWith(["f1"], true);
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

	it("does not create another chat when retrying after a failed send", async () => {
		const newChat: Chat = {
			id: "c-new",
			type: "private",
			name: "bob",
			ownerId: "alice:test",
			members: [],
			createdAt: "2026-01-01T00:00:00Z",
		};
		vi.mocked(createChat).mockResolvedValueOnce({ chat: newChat });
		const d = deps({
			pendingChatWith: "bob:test",
			activeChatId: null,
			sendMessage: vi.fn((_o: unknown) => Promise.resolve(false)),
		});
		const { result, rerender } = renderHook((p: typeof d) => useChatSubmit(p), {
			initialProps: d,
		});

		await result.current(event());

		// The chat exists and is selected, but the send failed: the pending
		// state is dropped so the retry goes through the active-chat path.
		expect(d.clearPendingChat).toHaveBeenCalled();
		expect(d.setInputText).not.toHaveBeenCalled();

		rerender({ ...d, pendingChatWith: null, activeChatId: "c-new" });
		await result.current(event());

		expect(createChat).toHaveBeenCalledTimes(1);
		expect(d.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ chatId: "c-new", text: "hello" }),
		);
	});

	it("ignores a thread-only submit", async () => {
		const d = deps({ activeChatId: null, activeThreadId: "th1" });
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.sendMessage).not.toHaveBeenCalled();
		expect(d.setInputText).not.toHaveBeenCalled();
	});

	it("keeps the draft when sending fails", async () => {
		const d = deps({
			sendMessage: vi.fn((_o: unknown) => Promise.resolve(false)),
		});
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.sendMessage).toHaveBeenCalled();
		expect(d.setInputText).not.toHaveBeenCalled();
		expect(d.removePendingFiles).not.toHaveBeenCalled();
		expect(d.clearReply).not.toHaveBeenCalled();
		expect(d.clearPendingLocation).not.toHaveBeenCalled();
	});

	it("keeps the draft when sending throws", async () => {
		const d = deps({
			sendMessage: vi.fn((_o: unknown) =>
				Promise.reject(new Error("encrypt-failed")),
			),
		});
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.setInputText).not.toHaveBeenCalled();
		expect(d.removePendingFiles).not.toHaveBeenCalled();
	});

	it("keeps the editor open when editing fails", async () => {
		const d = deps({
			inputText: "fixed",
			editingMessage: {
				chatId: "c1",
				messageId: "m1",
				text: "old",
			},
			editMessage: vi.fn((_o: unknown) => Promise.resolve(false)),
		});
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.editMessage).toHaveBeenCalled();
		expect(d.clearEditing).not.toHaveBeenCalled();
		expect(d.setInputText).not.toHaveBeenCalled();
	});

	it("keeps the draft when creating the private chat fails", async () => {
		vi.mocked(createChat).mockRejectedValueOnce(new Error("down"));
		const d = deps({ pendingChatWith: "bob:test", activeChatId: null });
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.sendMessage).not.toHaveBeenCalled();
		expect(d.setInputText).not.toHaveBeenCalled();
		expect(d.clearPendingChat).not.toHaveBeenCalled();
	});

	it("sends the location picked while editing instead of dropping it", async () => {
		const d = deps({
			inputText: "fixed",
			pendingLocation: { lat: 1, lng: 2 },
			editingMessage: {
				chatId: "c1",
				messageId: "m1",
				text: "old",
				location: { lat: 9, lng: 9 },
			},
		});
		const { result } = renderHook(() => useChatSubmit(d));

		await result.current(event());

		expect(d.editMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				location: { lat: 1, lng: 2 },
				clearLocation: false,
			}),
		);
	});

	it("keeps a removed location removed when editing", async () => {
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

	it("does not erase a draft typed while the send was in flight", async () => {
		let resolveSend: (ok: boolean) => void = () => {};
		const sendMessage = vi.fn(
			(_o: unknown) =>
				new Promise<boolean | undefined>((resolve) => {
					resolveSend = resolve;
				}),
		);
		const d = deps({ sendMessage });
		const { result, rerender } = renderHook(
			(props: Parameters<typeof useChatSubmit>[0]) => useChatSubmit(props),
			{ initialProps: d },
		);

		const submit = result.current(event());
		await vi.waitFor(() => {
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		// The user kept typing (and attached a file) while the first message
		// was being encrypted/uploaded.
		const nextFile = {
			id: "f2",
			file: new File(["y"], "b.txt", { type: "text/plain" }),
			blobUrl: "blob:y",
			originalName: "b.txt",
			size: 1,
			mimeType: "text/plain",
			fileType: "file" as const,
			encrypted: true,
		};
		rerender({
			...d,
			inputText: "next draft",
			pendingFiles: [nextFile],
		});

		resolveSend(true);
		await submit;

		expect(d.setInputText).not.toHaveBeenCalled();
		expect(d.removePendingFiles).not.toHaveBeenCalled();
	});
});
