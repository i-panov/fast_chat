import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "../types/api.ts";
import { useMessageEditor } from "./useMessageEditor.ts";

function msg(id: string): Message {
	return {
		id,
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text: `text ${id}`,
		createdAt: "2026-01-01T00:00:00Z",
		location: { lat: 1, lng: 2 },
		files: [
			{
				id: "f1",
				mimeType: "text/plain",
				size: 3,
				originalName: "a.txt",
				fileType: "file",
				url: "https://srv/f1",
			},
		],
	};
}

describe("useMessageEditor", () => {
	it("starts editing with the message location", () => {
		const { result } = renderHook(() => useMessageEditor([msg("m1")]));

		act(() => {
			result.current.handleStartEdit("c1", "m1", "new text");
		});

		expect(result.current.editingMessage).toEqual({
			chatId: "c1",
			messageId: "m1",
			text: "new text",
			files: undefined,
			threadId: undefined,
			location: { lat: 1, lng: 2 },
		});
	});

	it("starts editing a message without location", () => {
		const { id, chatId, fromId, fromNick, text, createdAt } = msg("m1");
		const plain: Message = { id, chatId, fromId, fromNick, text, createdAt };
		const { result } = renderHook(() => useMessageEditor([plain]));

		act(() => {
			result.current.handleStartEdit("c1", "m1", "new text");
		});

		expect(result.current.editingMessage?.location).toBeNull();
	});

	it("removes attached files and the location", () => {
		const { result } = renderHook(() => useMessageEditor([msg("m1")]));

		act(() => {
			result.current.handleStartEdit("c1", "m1", "t", [
				{
					id: "f1",
					mimeType: "text/plain",
					size: 1,
					originalName: "a",
					fileType: "file",
					url: "u",
				},
				{
					id: "f2",
					mimeType: "text/plain",
					size: 1,
					originalName: "b",
					fileType: "file",
					url: "u",
				},
			]);
			result.current.handleRemoveExistingFile("f1");
		});
		expect(result.current.editingMessage?.files?.map((f) => f.id)).toEqual([
			"f2",
		]);

		act(() => {
			result.current.handleRemoveExistingLocation();
		});
		expect(result.current.editingMessage?.location).toBeNull();

		act(() => {
			result.current.clearEditing();
		});
		expect(result.current.editingMessage).toBeNull();
	});

	it("ignores removals without an edited message", () => {
		const { result } = renderHook(() => useMessageEditor([]));

		act(() => {
			result.current.handleRemoveExistingFile("f1");
			result.current.handleRemoveExistingLocation();
		});

		expect(result.current.editingMessage).toBeNull();
	});

	it("replies to a message and cancels", () => {
		const { result } = renderHook(() => useMessageEditor([msg("m1")]));

		act(() => {
			result.current.handleReply("c1", "m1");
		});
		expect(result.current.replyToMessage).toEqual({
			chatId: "c1",
			messageId: "m1",
			fromNick: "bob",
			text: "text m1",
			files: msg("m1").files,
		});

		act(() => {
			result.current.cancelReply();
		});
		expect(result.current.replyToMessage).toBeNull();
	});

	it("ignores replies to unknown messages", () => {
		const { result } = renderHook(() => useMessageEditor([]));

		act(() => {
			result.current.handleReply("c1", "nope");
		});

		expect(result.current.replyToMessage).toBeNull();
	});

	it("tracks the latest messages through the ref", () => {
		const { result, rerender } = renderHook(
			({ messages }) => useMessageEditor(messages),
			{ initialProps: { messages: [] as Message[] } },
		);
		rerender({ messages: [msg("m1")] });

		act(() => {
			result.current.handleReply("c1", "m1");
		});

		expect(result.current.replyToMessage?.text).toBe("text m1");
	});
});
