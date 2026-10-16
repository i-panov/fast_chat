import { beforeEach, describe, expect, it } from "vitest";
import type { Chat } from "../types/api.ts";
import { chatsRepo } from "./chatsRepo.ts";
import { setActiveAccountKey } from "./init.ts";
import { outboxRepo } from "./outboxRepo.ts";

function chat(id: string, type: Chat["type"], createdAt: string): Chat {
	return {
		id,
		type,
		name: id,
		ownerId: "alice:test",
		members: [{ id: "alice:test", nick: "alice" }],
		createdAt,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("chatsRepo", () => {
	it("sorts self chats first, then by date", async () => {
		await chatsRepo.upsertMany([
			chat("g2", "group", "2026-01-03T00:00:00Z"),
			chat("g1", "group", "2026-01-02T00:00:00Z"),
			chat("self", "self", "2026-01-01T00:00:00Z"),
		]);

		expect((await chatsRepo.getAll()).map((c) => c.id)).toEqual([
			"self",
			"g1",
			"g2",
		]);
		expect((await chatsRepo.getById("g1"))?.name).toBe("g1");
		expect(await chatsRepo.getById("missing")).toBeUndefined();
	});

	it("ignores empty batches", async () => {
		await chatsRepo.upsertMany([]);
		await chatsRepo.removeMany([]);

		expect(await chatsRepo.getAll()).toEqual([]);
	});

	it("removes one or many chats", async () => {
		await chatsRepo.upsertMany([
			chat("g1", "group", "2026-01-02T00:00:00Z"),
			chat("g2", "group", "2026-01-03T00:00:00Z"),
		]);

		await chatsRepo.remove("g1");
		expect((await chatsRepo.getAll()).map((c) => c.id)).toEqual(["g2"]);

		await chatsRepo.removeMany(["g2"]);
		expect(await chatsRepo.getAll()).toEqual([]);
	});

	it("tracks member presence", async () => {
		await chatsRepo.upsert({
			...chat("g1", "group", "2026-01-02T00:00:00Z"),
			members: [
				{ id: "alice:test", nick: "alice" },
				{ id: "bob:test", nick: "bob", online: false },
			],
		});

		await chatsRepo.updateMemberStatus("bob:test", true);
		expect(
			(await chatsRepo.getById("g1"))?.members.find((m) => m.id === "bob:test")
				?.online,
		).toBe(true);

		await chatsRepo.updateMemberStatus("ghost:test", true);
		expect((await chatsRepo.getById("g1"))?.members).toHaveLength(2);
	});
});

describe("outboxRepo count", () => {
	it("counts queued ops", async () => {
		expect(await outboxRepo.count()).toBe(0);

		await outboxRepo.enqueue({
			kind: "send",
			opId: "op1",
			chatId: "c1",
			msgId: "m1",
			text: "hi",
			encrypted: false,
			pendingFileClientIds: [],
			fileHashes: [],
			createdAt: "2026-01-01T00:00:00Z",
			attempts: 0,
		});

		expect(await outboxRepo.count()).toBe(1);
	});
});
