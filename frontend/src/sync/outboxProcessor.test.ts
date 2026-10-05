import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp, OutboxOpSend } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { extractRetryAfterMs, processOutbox } from "./outboxProcessor.ts";

vi.mock("../api.ts", () => ({
	getSync: vi.fn(),
	sendMessage: vi.fn(),
	editMessage: vi.fn(),
	deleteMessage: vi.fn(),
	uploadFile: vi.fn(),
}));

import type { Mock } from "vitest";
import { deleteMessage, editMessage, sendMessage, uploadFile } from "../api.ts";

const sendMessageMock = sendMessage as Mock;
const editMessageMock = editMessage as Mock;
const deleteMessageMock = deleteMessage as Mock;
const uploadFileMock = uploadFile as Mock;

function sendOp(overrides: Partial<OutboxOpSend> = {}): OutboxOpSend {
	return {
		kind: "send",
		opId: "send-op-1",
		chatId: "chat-1",
		msgId: "m1",
		text: "hello",
		pendingFileClientIds: [],
		createdAt: "2026-08-30T09:00:00.000Z",
		attempts: 0,
		...overrides,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
	sendMessageMock.mockResolvedValue({ message: {} });
	editMessageMock.mockResolvedValue({ message: {} });
	deleteMessageMock.mockResolvedValue({ status: "ok" });
	uploadFileMock.mockResolvedValue({ file: { id: "file-1" } });
});

describe("extractRetryAfterMs", () => {
	it("parses numeric seconds and caps the wait", () => {
		expect(
			extractRetryAfterMs(new Error("http 429: slow down retry-after:10")),
		).toBe(10000);
		expect(extractRetryAfterMs(new Error("retry-after: 3600"))).toBe(300000);
	});

	it("parses an absolute HTTP date", () => {
		const future = new Date(Date.now() + 60_000).toUTCString();
		const ms = extractRetryAfterMs(new Error(`retry-after:${future}`));
		expect(ms).toBeGreaterThan(0);
		expect(ms).toBeLessThanOrEqual(300000);
	});

	it("rejects malformed, zero, negative, and past retry-after", () => {
		expect(extractRetryAfterMs(new Error("retry-after:-5"))).toBeNull();
		expect(extractRetryAfterMs(new Error("retry-after:0"))).toBeNull();
		expect(extractRetryAfterMs(new Error("retry-after:abc"))).toBeNull();
		expect(
			extractRetryAfterMs(
				new Error(`retry-after:${new Date(Date.now() - 1000).toUTCString()}`),
			),
		).toBeNull();
	});

	it("returns null for non-Error and unrelated messages", () => {
		expect(extractRetryAfterMs("nope")).toBeNull();
		expect(extractRetryAfterMs(new Error("network down"))).toBeNull();
	});
});

describe("processOutbox", () => {
	it("no-ops on an empty outbox", async () => {
		await processOutbox("tok");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("sends a queued message and removes the op", async () => {
		await messagesRepo.upsert(
			{
				id: "m1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "hello",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"queued",
		);
		await outboxRepo.enqueue(sendOp());

		await processOutbox("tok");

		expect(sendMessageMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ id: "m1", text: "hello" }),
		);

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.status).toBe("sent");
		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("uploads pending files and passes their ids to sendMessage", async () => {
		await pendingBlobsRepo.put({
			id: "blob-1",
			blob: new Blob(["x"]),
			name: "a.txt",
			mimeType: "text/plain",
			size: 1,
		});
		await outboxRepo.enqueue(
			sendOp({ pendingFileClientIds: ["blob-1"], fileHashes: ["hash-abc"] }),
		);

		await processOutbox("tok");

		expect(uploadFileMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ name: "a.txt" }),
			undefined,
			true,
		);
		expect(sendMessageMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ fileIDs: ["file-1"] }),
		);
		expect(await pendingBlobsRepo.get("blob-1")).toBeUndefined();
		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("skips already-failed ops", async () => {
		await outboxRepo.enqueue({ ...sendOp(), status: "failed" });

		await processOutbox("tok");

		expect(sendMessageMock).not.toHaveBeenCalled();
		expect(await outboxRepo.list()).toHaveLength(1);
	});

	it("marks the op failed and the message failed on a definitive error", async () => {
		await messagesRepo.upsert(
			{
				id: "m1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "hello",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"queued",
		);
		await outboxRepo.enqueue(sendOp());
		sendMessageMock.mockRejectedValue(new Error("http 400: bad"));

		await processOutbox("tok");

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(1);
		expect(ops[0].status).toBe("failed");

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.status).toBe("failed");
	});

	it("stops processing on a transient error and keeps the op pending", async () => {
		const op1 = sendOp({ opId: "send-1", msgId: "m1" });
		const op2 = sendOp({ opId: "send-2", msgId: "m2" });
		await outboxRepo.enqueue(op1);
		await outboxRepo.enqueue(op2);

		sendMessageMock.mockRejectedValue(new Error("network unavailable"));

		await processOutbox("tok");

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(2);
		expect(ops.every((o) => o.status === undefined)).toBe(true);
	});

	it("treats an http 500 as transient (api format: status followed by colon)", async () => {
		await outboxRepo.enqueue(sendOp());
		sendMessageMock.mockRejectedValue(
			new Error("http 500: internal server error"),
		);

		await processOutbox("tok");

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(1);
		expect(ops[0].status).toBeUndefined();
	});

	it("treats an http 429 without retry-after as transient", async () => {
		await outboxRepo.enqueue(sendOp());
		sendMessageMock.mockRejectedValue(new Error("http 429: too many requests"));

		await processOutbox("tok");

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(1);
		expect(ops[0].status).toBeUndefined();
	});

	it("sends to the thread endpoint thread using threadId and marks thread message sent", async () => {
		await threadMessagesRepo.upsert(
			{
				id: "tm1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "thread hello",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"thread-1",
			"queued",
		);
		await outboxRepo.enqueue(
			sendOp({
				opId: "t-send",
				threadId: "thread-1",
				msgId: "tm1",
				text: "thread hello",
			}),
		);

		await processOutbox("tok");

		expect(sendMessageMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ threadId: "thread-1" }),
		);
		const stored = await threadMessagesRepo.getById("thread-1", "tm1");
		expect(stored?.status).toBe("sent");
		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("deletes a message and removes the op", async () => {
		await messagesRepo.upsert(
			{
				id: "m1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "hello",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"sent",
		);
		await outboxRepo.enqueue({
			kind: "delete",
			opId: "del-op-1",
			chatId: "chat-1",
			messageId: "m1",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await processOutbox("tok");

		expect(deleteMessageMock).toHaveBeenCalledWith("tok", "chat-1", "m1");
		expect(await messagesRepo.getById("chat-1", "m1")).toBeUndefined();
		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("deletes a thread message by its real chat, not the thread id", async () => {
		await threadMessagesRepo.upsert(
			{
				id: "t-msg",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "in thread",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"thread-1",
			"sent",
		);
		await outboxRepo.enqueue({
			kind: "delete",
			opId: "del-thread",
			chatId: "chat-1",
			threadId: "thread-1",
			messageId: "t-msg",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await processOutbox("tok");

		// The thread id is not a chat, so sending it would 404 on the server's
		// membership check.
		expect(deleteMessageMock).toHaveBeenCalledWith("tok", "chat-1", "t-msg");
		expect(
			await threadMessagesRepo.getById("thread-1", "t-msg"),
		).toBeUndefined();
		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("treats a 404 delete as already-deleted", async () => {
		deleteMessageMock.mockRejectedValue(new Error("http 404"));
		await outboxRepo.enqueue({
			kind: "delete",
			opId: "del-op-2",
			chatId: "chat-1",
			messageId: "gone",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await processOutbox("tok");

		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("edits a message and removes the op", async () => {
		await messagesRepo.upsert(
			{
				id: "m1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "old",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"sent",
		);
		await outboxRepo.enqueue({
			kind: "edit",
			opId: "edit-op-1",
			chatId: "chat-1",
			messageId: "m1",
			text: "new",
			pendingFileClientIds: [],
			keptFileIds: ["file-9"],
			filesToRemove: [],
			clientEditedAt: "2026-08-30T10:00:00.000Z",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await processOutbox("tok");

		expect(editMessageMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ messageId: "m1", fileIDs: ["file-9"] }),
		);
		expect(await messagesRepo.getById("chat-1", "m1")).toMatchObject({
			status: "sent",
		});
		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("continues to the next op after a definitive failure", async () => {
		const op1: OutboxOp = sendOp({ opId: "send-1", msgId: "m1" });
		const op2: OutboxOp = {
			kind: "delete",
			opId: "del-after",
			chatId: "chat-1",
			messageId: "mz",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		};
		await outboxRepo.enqueue(op1);
		await outboxRepo.enqueue(op2);
		sendMessageMock.mockRejectedValue(new Error("http 400: bad"));

		await processOutbox("tok");

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(1);
		expect(ops[0].kind).toBe("send");
		expect(ops[0].status).toBe("failed");
	});
});
