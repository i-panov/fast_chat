import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { OutboxOp, OutboxOpSend } from "../db/schema.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { processOutbox } from "./outboxProcessor.ts";

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

describe("processOutbox edits and deletes", () => {
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

	it("backs off for Retry-After before the next tick", async () => {
		await outboxRepo.enqueue(sendOp({ opId: "send-1", msgId: "m1" }));
		await outboxRepo.enqueue(sendOp({ opId: "send-2", msgId: "m2" }));
		sendMessageMock.mockRejectedValue(
			new Error("http 429: slow retry-after:1"),
		);

		await processOutbox("tok");

		// The backoff consumed the tick: the second op was never attempted,
		// and nothing failed.
		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		expect((await outboxRepo.list()).map((o) => o.status)).toEqual([
			undefined,
			undefined,
		]);
	});

	it("fails the op on unauthorized", async () => {
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
		sendMessageMock.mockRejectedValue(new Error("unauthorized"));

		await processOutbox("tok");

		expect((await outboxRepo.list())[0].status).toBe("failed");
	});

	it("keeps the op on non-Error throws", async () => {
		await outboxRepo.enqueue(sendOp());
		sendMessageMock.mockRejectedValue("boom");

		await processOutbox("tok");

		expect((await outboxRepo.list())[0].status).toBeUndefined();
	});

	it("edits with uploaded files and in threads", async () => {
		await pendingBlobsRepo.put({
			id: "blob-1",
			blob: new Blob(["x"]),
			name: "a.txt",
			mimeType: "text/plain",
			size: 1,
		});
		await threadMessagesRepo.upsert(
			{
				id: "tm1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "old",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"thread-1",
			"sent",
		);
		await outboxRepo.enqueue({
			kind: "edit",
			opId: "edit-thread",
			chatId: "chat-1",
			threadId: "thread-1",
			messageId: "tm1",
			text: "new",
			pendingFileClientIds: ["blob-1"],
			keptFileIds: ["kept-1"],
			filesToRemove: [],
			clientEditedAt: "2026-08-30T10:00:00.000Z",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await processOutbox("tok");

		expect(editMessageMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ threadId: "thread-1", fileIDs: ["file-1"] }),
		);
		expect((await threadMessagesRepo.getById("thread-1", "tm1"))?.status).toBe(
			"sent",
		);
		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("edits without any files", async () => {
		await outboxRepo.enqueue({
			kind: "edit",
			opId: "edit-plain",
			chatId: "chat-1",
			messageId: "m1",
			text: "new",
			pendingFileClientIds: [],
			keptFileIds: [],
			filesToRemove: [],
			clientEditedAt: "2026-08-30T10:00:00.000Z",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await processOutbox("tok");

		expect(editMessageMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ fileIDs: undefined }),
		);
	});

	it("fails the op when a staged blob vanished instead of sending without the file", async () => {
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
		await outboxRepo.enqueue(
			sendOp({ msgId: "m1", pendingFileClientIds: ["gone"] }),
		);

		await processOutbox("tok");

		// A vanished blob must not silently trim the file set: the send is
		// blocked and the op fails instead.
		expect(uploadFileMock).not.toHaveBeenCalled();
		expect(sendMessageMock).not.toHaveBeenCalled();
		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(1);
		expect(ops[0].status).toBe("failed");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("failed");
	});

	it("treats a 404 thread delete as already-deleted", async () => {
		deleteMessageMock.mockRejectedValue(new Error("message not found"));
		await outboxRepo.enqueue({
			kind: "delete",
			opId: "del-thread-404",
			chatId: "chat-1",
			threadId: "thread-1",
			messageId: "gone",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});

		await processOutbox("tok");

		expect(await outboxRepo.list()).toHaveLength(0);
	});

	it("keeps the local copy when a delete definitively fails", async () => {
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
			opId: "del-fail",
			chatId: "chat-1",
			messageId: "m1",
			createdAt: "2026-08-30T09:30:00.000Z",
			attempts: 0,
		});
		deleteMessageMock.mockRejectedValue(new Error("http 400: bad"));

		await processOutbox("tok");

		// Removing the row locally while the server kept it would resurrect
		// the message as a ghost on the next delta, so it stays.
		expect(await messagesRepo.getById("chat-1", "m1")).toBeDefined();
		expect((await outboxRepo.list())[0].status).toBe("failed");
	});

	it("marks thread messages failed on definitive send errors", async () => {
		await threadMessagesRepo.upsert(
			{
				id: "tm1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "hi",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"thread-1",
			"queued",
		);
		await outboxRepo.enqueue(
			sendOp({ opId: "t-fail", threadId: "thread-1", msgId: "tm1" }),
		);
		sendMessageMock.mockRejectedValue(new Error("http 400: bad"));

		await processOutbox("tok");

		expect((await threadMessagesRepo.getById("thread-1", "tm1"))?.status).toBe(
			"failed",
		);
	});
});
