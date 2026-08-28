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
