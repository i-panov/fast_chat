import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../types/api.ts";
import { setActiveAccountKey } from "./init.ts";
import { messagesRepo } from "./messagesRepo.ts";

function msg(id: string, createdAt: string, text: string): Message {
	return {
		id,
		chatId: "chat-1",
		fromId: "alice:test",
		fromNick: "alice",
		text,
		createdAt,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("messagesRepo.getByChat ordering", () => {
	it("keeps a newer client-format message last even when it shares a second with server-format messages", async () => {
		// Server (RFC3339Nano, trailing zeros trimmed) messages in the
		// same second: exact-second and 900ms.
		const oldExact = msg("old-exact", "2026-08-26T14:45:09Z", "old exact");
		const old900 = msg("old-900", "2026-08-26T14:45:09.9Z", "old 900");
		// A newer client (toISOString) message at 973ms.
		const newClient = msg(
			"new-client",
			"2026-08-26T14:45:09.973Z",
			"new client",
		);

		// Insert in shuffled order to prove sorting is applied.
		await messagesRepo.upsertMany([newClient, old900, oldExact]);

		const ordered = await messagesRepo.getByChat("chat-1");
		expect(ordered.map((m) => m.id)).toEqual([
			"old-exact",
			"old-900",
			"new-client",
		]);
	});

	it("sorts across seconds numerically", async () => {
		await messagesRepo.upsertMany([
			msg("m2", "2026-08-26T14:45:10.100Z", "second"),
			msg("m1", "2026-08-26T14:45:09.900Z", "first"),
		]);

		const ordered = await messagesRepo.getByChat("chat-1");
		expect(ordered.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("does not leak messages between accounts", async () => {
		await messagesRepo.upsertMany([
			msg("alice-msg", "2026-08-26T14:45:09Z", "alice only"),
		]);

		setActiveAccountKey("bob:test");
		expect(await messagesRepo.getByChat("chat-1")).toEqual([]);
	});
});

describe("messagesRepo lookups", () => {
	it("finds by id and respects the chat boundary", async () => {
		await messagesRepo.upsertMany([msg("m1", "2026-08-26T14:45:09Z", "one")]);

		expect((await messagesRepo.getById("chat-1", "m1"))?.text).toBe("one");
		expect(await messagesRepo.getById("chat-1", "missing")).toBeUndefined();
		expect(await messagesRepo.getById("other-chat", "m1")).toBeUndefined();
		expect((await messagesRepo.getByIdAny("m1"))?.text).toBe("one");
		expect(await messagesRepo.getByIdAny("missing")).toBeUndefined();
	});
});

describe("messagesRepo mutations", () => {
	it("preserves queued status and read state on re-upsert", async () => {
		await messagesRepo.upsert(
			{ ...msg("m1", "2026-08-26T14:45:09Z", "one") },
			"queued",
		);
		await messagesRepo.upsert(msg("m1", "2026-08-26T14:45:09Z", "one"));

		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("queued");

		await messagesRepo.updateDeliveryStatus("m1", "read", ["bob:test"]);
		await messagesRepo.upsert({
			...msg("m1", "2026-08-26T14:45:09Z", "one"),
			deliveryStatus: "delivered",
		});

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.deliveryStatus).toBe("read");
		expect(stored?.readBy).toEqual(["bob:test"]);
	});

	it("applies and removes deletes within the chat", async () => {
		await messagesRepo.upsertMany([msg("m1", "2026-08-26T14:45:09Z", "one")]);

		await messagesRepo.applyDelete("chat-1", "missing");
		await messagesRepo.applyDelete("other-chat", "m1");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("sent");

		await messagesRepo.applyDelete("chat-1", "m1");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe(
			"deleted",
		);

		await messagesRepo.remove("other-chat", "m1");
		expect(await messagesRepo.getById("chat-1", "m1")).toBeTruthy();
		await messagesRepo.remove("chat-1", "missing");
		await messagesRepo.remove("chat-1", "m1");
		expect(await messagesRepo.getById("chat-1", "m1")).toBeUndefined();
	});

	it("marks statuses within the chat", async () => {
		await messagesRepo.upsertMany([msg("m1", "2026-08-26T14:45:09Z", "one")]);

		await messagesRepo.markStatus("chat-1", "missing", "failed");
		await messagesRepo.markStatus("other-chat", "m1", "failed");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("sent");

		await messagesRepo.markStatus("chat-1", "m1", "failed");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("failed");
	});

	it("tracks pending, delivery and read ids", async () => {
		await messagesRepo.upsertMany([
			msg("m1", "2026-08-26T14:45:09Z", "one"),
			msg("m2", "2026-08-26T14:45:10Z", "two"),
		]);
		await messagesRepo.markStatus("chat-1", "m1", "queued");

		expect((await messagesRepo.getPending()).map((m) => m.id)).toEqual(["m1"]);

		await messagesRepo.updateDeliveryStatus("missing", "delivered");
		await messagesRepo.updateDeliveryStatus("m2", "delivered");
		expect((await messagesRepo.getById("chat-1", "m2"))?.deliveryStatus).toBe(
			"delivered",
		);

		await messagesRepo.markAsRead([]);
		await messagesRepo.markAsRead(["m1", "missing"]);
		expect(await messagesRepo.getReadMessageIds()).toEqual(["m1"]);
	});
});
