import { beforeEach, describe, expect, it } from "vitest";
import type { Thread } from "../types/api.ts";
import { setActiveAccountKey } from "./init.ts";
import { threadsRepo } from "./threadsRepo.ts";

function thread(id: string, chatId: string): Thread {
	return {
		id,
		chatId,
		parentMessageId: `parent-${id}`,
		parentMessageText: "parent",
		parentMessageFrom: "alice",
		createdAt: "2026-01-01T00:00:00Z",
		messageCount: 1,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("threadsRepo", () => {
	it("upserts and reads back by id", async () => {
		await threadsRepo.upsert(thread("t1", "c1"));

		const got = await threadsRepo.getById("t1");
		expect(got?.parentMessageId).toBe("parent-t1");
		expect(await threadsRepo.getById("missing")).toBeUndefined();
	});

	it("lists threads scoped to a chat", async () => {
		await threadsRepo.upsertMany([thread("t1", "c1"), thread("t2", "c2")]);

		expect((await threadsRepo.getByChat("c1")).map((t) => t.id)).toEqual([
			"t1",
		]);
		expect(await threadsRepo.getAll()).toHaveLength(2);
	});

	it("ignores empty upserts", async () => {
		await threadsRepo.upsertMany([]);

		expect(await threadsRepo.getAll()).toEqual([]);
	});

	it("removes a single thread", async () => {
		await threadsRepo.upsertMany([thread("t1", "c1"), thread("t2", "c1")]);
		await threadsRepo.remove("t1");

		expect((await threadsRepo.getByChat("c1")).map((t) => t.id)).toEqual([
			"t2",
		]);
	});

	it("removes all threads of a chat", async () => {
		await threadsRepo.upsertMany([thread("t1", "c1"), thread("t2", "c1")]);
		await threadsRepo.removeByChat("c1");

		expect(await threadsRepo.getByChat("c1")).toEqual([]);
	});

	it("removeByChat is a no-op for an empty chat", async () => {
		await threadsRepo.removeByChat("nope");

		expect(await threadsRepo.getAll()).toEqual([]);
	});

	it("does not leak threads between accounts", async () => {
		await threadsRepo.upsert(thread("t1", "c1"));

		setActiveAccountKey("bob:test");
		expect(await threadsRepo.getAll()).toEqual([]);
	});
});
