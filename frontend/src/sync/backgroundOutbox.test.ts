import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { sendMessage } from "../api.ts";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import type { OutboxOpSend } from "../db/schema.ts";
import { runBackgroundOutbox } from "./backgroundOutbox.ts";
import {
	clearBackgroundSession,
	readBackgroundSession,
	setBackgroundSession,
} from "./backgroundSession.ts";

vi.mock("../api.ts", () => ({
	sendMessage: vi.fn(),
	editMessage: vi.fn(),
	deleteMessage: vi.fn(),
	uploadFile: vi.fn(),
	addMessageReaction: vi.fn(),
	removeMessageReaction: vi.fn(),
	pinMessage: vi.fn(),
	unpinMessage: vi.fn(),
	markMessagesRead: vi.fn(),
}));

const sendMessageMock = sendMessage as Mock;

function sendOp(): OutboxOpSend {
	return {
		kind: "send",
		opId: "send-op-1",
		chatId: "chat-1",
		msgId: "m1",
		text: "queued offline",
		pendingFileClientIds: [],
		createdAt: "2026-08-30T09:00:00.000Z",
		attempts: 0,
	};
}

async function seedQueuedMessage(): Promise<void> {
	setActiveAccountKey("alice:test");
	await messagesRepo.upsert(
		{
			id: "m1",
			chatId: "chat-1",
			fromId: "alice:test",
			fromNick: "alice",
			text: "queued offline",
			createdAt: "2026-08-30T09:00:00.000Z",
		},
		"queued",
	);
	await outboxRepo.enqueue(sendOp());
	// The worker opens the account database itself, as if the app was closed.
	setActiveAccountKey(null);
}

beforeEach(async () => {
	vi.clearAllMocks();
	await clearBackgroundSession();
	sendMessageMock.mockResolvedValue({ message: {} });
});

describe("runBackgroundOutbox", () => {
	it("does nothing without mirrored credentials", async () => {
		await runBackgroundOutbox();

		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("sends the queue of the mirrored account", async () => {
		await seedQueuedMessage();
		await setBackgroundSession({ token: "tok", accountKey: "alice:test" });

		await runBackgroundOutbox();

		expect(sendMessageMock).toHaveBeenCalledWith(
			"tok",
			expect.objectContaining({ chatId: "chat-1", id: "m1" }),
		);

		setActiveAccountKey("alice:test");
		expect(await outboxRepo.list()).toEqual([]);
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("sent");
	});

	it("drops an expired session instead of failing the queue", async () => {
		await seedQueuedMessage();
		await setBackgroundSession({ token: "stale", accountKey: "alice:test" });
		sendMessageMock.mockRejectedValue(new Error("unauthorized"));

		await runBackgroundOutbox();

		expect(await readBackgroundSession()).toBeNull();
		setActiveAccountKey("alice:test");
		expect((await outboxRepo.list())[0].status).toBeUndefined();
	});

	it("rethrows a transient failure so the browser retries the sync", async () => {
		await seedQueuedMessage();
		await setBackgroundSession({ token: "tok", accountKey: "alice:test" });
		sendMessageMock.mockRejectedValue(new Error("http 503: unavailable"));

		await expect(runBackgroundOutbox()).rejects.toThrow("transient");

		setActiveAccountKey("alice:test");
		expect(await outboxRepo.list()).toHaveLength(1);
	});
});
