import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOpEdit, OutboxOpSend } from "../db/schema.ts";
import type { Chat, Message, SyncResponse } from "../types/api.ts";
import { applyDelta, pullDelta } from "./deltaApplier.ts";

vi.mock("../api.ts", () => ({
	getSync: vi.fn(),
	sendMessage: vi.fn(),
	editMessage: vi.fn(),
	deleteMessage: vi.fn(),
	uploadFile: vi.fn(),
}));

import type { Mock } from "vitest";
import { getSync } from "../api.ts";

const getSyncMock = getSync as Mock;

function chat(id: string, name: string, memberIds: string[] = []): Chat {
	return {
		id,
		type: id === "self" ? "self" : "group",
		name,
		ownerId: "alice:test",
		members: memberIds.map((id) => ({ id, nick: id })),
		createdAt: "2026-08-30T09:00:00.000Z",
	};
}

function msg(id: string, text: string, editedAt?: string): Message {
	return {
		id,
		chatId: "chat-1",
		fromId: "alice:test",
		fromNick: "alice",
		text,
		createdAt: "2026-08-30T09:00:00.000Z",
		...(editedAt !== undefined ? { editedAt } : {}),
	};
}

function sendOp(overrides: Partial<OutboxOpSend> = {}): OutboxOpSend {
	return {
		kind: "send",
		opId: "send-op",
		chatId: "chat-1",
		msgId: "m1",
		text: "queued send",
		pendingFileClientIds: [],
		createdAt: "2026-08-30T09:00:00.000Z",
		attempts: 0,
		...overrides,
	};
}

function editOp(overrides: Partial<OutboxOpEdit> = {}): OutboxOpEdit {
	return {
		kind: "edit",
		opId: "edit-op",
		chatId: "chat-1",
		messageId: "m1",
		text: "local edit",
		pendingFileClientIds: [],
		keptFileIds: [],
		filesToRemove: [],
		clientEditedAt: "2026-08-30T10:00:00.000Z",
		createdAt: "2026-08-30T09:30:00.000Z",
		attempts: 0,
		...overrides,
	};
}

function delta(overrides: Partial<SyncResponse> = {}): SyncResponse {
	return {
		serverNow: "2026-08-30T11:00:00.000Z",
		chats: [],
		deletedChats: [],
		messages: [],
		deletedMessages: [],
		...overrides,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("applyDelta", () => {
	it("upserts chats, messages, and records serverNow", async () => {
		await applyDelta(
			delta({
				chats: [chat("chat-1", "room", ["alice:test"])],
				messages: [msg("m1", "hello"), msg("m2", "world")],
			}),
		);

		expect(await chatsRepo.getById("chat-1")).toMatchObject({ name: "room" });

		const stored = await messagesRepo.getByChat("chat-1");
		expect(stored.map((m) => m.text)).toEqual(["hello", "world"]);
		expect(await metaRepo.getLastSyncedAt()).toBe("2026-08-30T11:00:00.000Z");
	});

	it("removes deleted chats and applies deleted messages", async () => {
		await applyDelta(
			delta({ chats: [chat("gone", "gone")], messages: [msg("m1", "hello")] }),
		);

		await applyDelta(
			delta({
				deletedChats: [{ chatId: "gone", deletedAt: "2026-08-30T10:00:00Z" }],
				deletedMessages: [
					{
						chatId: "chat-1",
						messageId: "m1",
						deletedAt: "2026-08-30T10:00:00Z",
					},
				],
			}),
		);

		expect(await chatsRepo.getById("gone")).toBeUndefined();

		const stored = await messagesRepo.getByChat("chat-1");
		expect(stored).toHaveLength(1);
		expect(stored[0].id).toBe("m1");
		expect(stored[0].status).toBe("deleted");
	});

	// A member that left a group and came back is in the chat list again.
	// The tombstone of the earlier removal must not delete it.
	it("keeps a chat that was removed and added again", async () => {
		await applyDelta(
			delta({
				chats: [chat("chat-1", "room", ["alice:test"])],
				deletedChats: [{ chatId: "chat-1", deletedAt: "2026-08-30T10:00:00Z" }],
			}),
		);

		expect(await chatsRepo.getById("chat-1")).toMatchObject({ name: "room" });
	});

	// The messages of the threads live in their own store: they must not end
	// up in the chat feed.
	it("stores the thread messages in the thread store", async () => {
		const { threadMessagesRepo } = await import("../db/threadMessagesRepo.ts");

		await applyDelta(
			delta({
				messages: [msg("m1", "hello")],
				threadMessages: [{ ...msg("tm1", "in the thread"), threadId: "th1" }],
			}),
		);

		const chatMessages = await messagesRepo.getByChat("chat-1");
		expect(chatMessages.map((m) => m.id)).toEqual(["m1"]);

		const threadMessage = await threadMessagesRepo.getById("th1", "tm1");
		expect(threadMessage?.text).toBe("in the thread");
	});

	it("patches online status of chat members", async () => {
		await applyDelta(
			delta({
				chats: [chat("chat-1", "room", ["alice:test", "bob:test"])],
			}),
		);

		await applyDelta(delta({ onlineStatus: { "bob:test": true } }));

		const stored = await chatsRepo.getById("chat-1");
		const bob = stored?.members.find((m) => m.id === "bob:test");
		expect(bob?.online).toBe(true);
		const alice = stored?.members.find((m) => m.id === "alice:test");
		expect(alice?.online).toBeUndefined();
	});

	it("keeps the local queued send and skips the server record", async () => {
		await messagesRepo.upsert({ ...msg("m1", "local queued text") }, "queued");
		await outboxRepo.enqueue(sendOp());

		await applyDelta(delta({ messages: [msg("m1", "server text")] }));

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.status).toBe("queued");
		expect(stored?.text).toBe("local queued text");
	});

	it("keeps a local failed message", async () => {
		await messagesRepo.upsert({ ...msg("m1", "failed text") }, "failed");

		await applyDelta(delta({ messages: [msg("m1", "server text")] }));

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.status).toBe("failed");
		expect(stored?.text).toBe("failed text");
	});

	it("drops a queued edit beaten by a fresher server edit and cleans pending blobs", async () => {
		await pendingBlobsRepo.put({
			id: "blob-1",
			blob: new Blob(["x"]),
			name: "a.txt",
			mimeType: "text/plain",
			size: 1,
		});
		await outboxRepo.enqueue(editOp({ pendingFileClientIds: ["blob-1"] }));

		// Server edit is 1s newer than clientEditedAt.
		await applyDelta(
			delta({
				messages: [msg("m1", "server edit", "2026-08-30T10:00:01.000Z")],
			}),
		);

		expect(await outboxRepo.list()).toHaveLength(0);
		expect(await pendingBlobsRepo.get("blob-1")).toBeUndefined();

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.text).toBe("server edit");
	});

	it("keeps a queued edit when the local edit is newer", async () => {
		await outboxRepo.enqueue(editOp());

		await applyDelta(
			delta({
				messages: [msg("m1", "older server edit", "2026-08-30T09:59:00.000Z")],
			}),
		);

		expect(await outboxRepo.list()).toHaveLength(1);
	});

	it("accepts a malformed server edit timestamp as-is", async () => {
		await outboxRepo.enqueue(
			editOp({ clientEditedAt: "2026-08-30T10:00:00.000Z" }),
		);

		await applyDelta(
			delta({ messages: [msg("m1", "server edit", "not-a-date")] }),
		);

		expect(await outboxRepo.list()).toHaveLength(1);
		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.text).toBe("server edit");
	});

	it("does not delete a message that has a queued send op", async () => {
		await messagesRepo.upsert({ ...msg("m1", "hello") }, "queued");
		await outboxRepo.enqueue(sendOp());

		await applyDelta(
			delta({
				deletedMessages: [
					{
						chatId: "chat-1",
						messageId: "m1",
						deletedAt: "2026-08-30T10:00:00Z",
					},
				],
			}),
		);

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored).toBeDefined();
		expect(stored?.status).toBe("queued");
		expect(await outboxRepo.list()).toHaveLength(1);
	});

	it("removes a redundant queued delete op when the server already deleted the message", async () => {
		await messagesRepo.upsert({ ...msg("m1", "hello") }, "sent");
		await outboxRepo.enqueue({
			kind: "delete",
			opId: "delete-op",
			chatId: "chat-1",
			messageId: "m1",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await applyDelta(
			delta({
				deletedMessages: [
					{
						chatId: "chat-1",
						messageId: "m1",
						deletedAt: "2026-08-30T10:00:00Z",
					},
				],
			}),
		);

		expect(await outboxRepo.list()).toHaveLength(0);

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.status).toBe("deleted");
	});
});

describe("pullDelta", () => {
	it("falls back to the epoch since", async () => {
		getSyncMock.mockResolvedValue(delta());

		await pullDelta("tok", null);

		expect(getSyncMock).toHaveBeenCalledWith("tok", "1970-01-01T00:00:00.000Z");
	});

	it("forwards an existing since", async () => {
		getSyncMock.mockResolvedValue(delta());

		await pullDelta("tok", "2026-08-30T10:00:00.000Z");

		expect(getSyncMock).toHaveBeenCalledWith("tok", "2026-08-30T10:00:00.000Z");
	});
});
