import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../types/api.ts";
import { setActiveAccountKey } from "./init.ts";
import { threadMessagesRepo } from "./threadMessagesRepo.ts";

function msg(id: string, createdAt = "2026-01-01T00:00:00Z"): Message {
	return {
		id,
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text: `text ${id}`,
		createdAt,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("threadMessagesRepo", () => {
	it("upserts and lists by thread in order", async () => {
		await threadMessagesRepo.upsertMany(
			[msg("m2", "2026-01-01T00:00:02Z"), msg("m1", "2026-01-01T00:00:01Z")],
			"th1",
		);

		expect(
			(await threadMessagesRepo.getByThread("th1")).map((m) => m.id),
		).toEqual(["m1", "m2"]);
		expect(await threadMessagesRepo.getByThread("other")).toEqual([]);
	});

	it("finds by id within the thread", async () => {
		await threadMessagesRepo.upsert(msg("m1"), "th1");

		expect(await threadMessagesRepo.getById("th1", "m1")).toBeTruthy();
		expect(await threadMessagesRepo.getById("th1", "missing")).toBeUndefined();
		expect(await threadMessagesRepo.getById("other", "m1")).toBeUndefined();
		expect(await threadMessagesRepo.getByIdAny("m1")).toBeTruthy();
		expect(await threadMessagesRepo.getByIdAny("missing")).toBeUndefined();
	});

	it("preserves createdAt and queued status on re-upsert", async () => {
		await threadMessagesRepo.upsert(msg("m1"), "th1", "queued");
		await threadMessagesRepo.upsert(msg("m1", "2026-06-01T00:00:00Z"), "th1");

		const stored = await threadMessagesRepo.getById("th1", "m1");
		expect(stored?.createdAt).toBe("2026-01-01T00:00:00Z");
		expect(stored?.status).toBe("queued");
	});

	it("ignores empty batches", async () => {
		await threadMessagesRepo.upsertMany([], "th1");

		expect(await threadMessagesRepo.getByThread("th1")).toEqual([]);
	});

	it("applies deletes within the thread", async () => {
		await threadMessagesRepo.upsert(msg("m1"), "th1");

		await threadMessagesRepo.applyDelete("th1", "missing");
		await threadMessagesRepo.applyDelete("other", "m1");
		expect((await threadMessagesRepo.getById("th1", "m1"))?.status).toBe(
			"sent",
		);

		await threadMessagesRepo.applyDelete("th1", "m1");
		expect((await threadMessagesRepo.getById("th1", "m1"))?.status).toBe(
			"deleted",
		);
	});

	it("removes within the thread", async () => {
		await threadMessagesRepo.upsert(msg("m1"), "th1");

		await threadMessagesRepo.remove("th1", "missing");
		await threadMessagesRepo.remove("other", "m1");
		expect(await threadMessagesRepo.getById("th1", "m1")).toBeTruthy();

		await threadMessagesRepo.remove("th1", "m1");
		expect(await threadMessagesRepo.getById("th1", "m1")).toBeUndefined();
	});

	it("marks statuses within the thread", async () => {
		await threadMessagesRepo.upsert(msg("m1"), "th1");

		await threadMessagesRepo.markStatus("th1", "missing", "failed");
		await threadMessagesRepo.markStatus("other", "m1", "failed");
		await threadMessagesRepo.markStatus("th1", "m1", "failed");

		expect((await threadMessagesRepo.getById("th1", "m1"))?.status).toBe(
			"failed",
		);
	});

	it("tracks delivery and read state", async () => {
		await threadMessagesRepo.upsert(msg("m1"), "th1");

		await threadMessagesRepo.updateDeliveryStatus("missing", "delivered");
		await threadMessagesRepo.updateDeliveryStatus("m1", "delivered", [
			"bob:test",
		]);

		const stored = await threadMessagesRepo.getById("th1", "m1");
		expect(stored?.deliveryStatus).toBe("delivered");
		expect(stored?.readBy).toEqual(["bob:test"]);

		await threadMessagesRepo.markAsRead([]);
		await threadMessagesRepo.markAsRead(["m1", "missing"]);
		expect(
			(await threadMessagesRepo.getById("th1", "m1"))?.deliveryStatus,
		).toBe("read");
	});

	it("preserves read receipts and queued status on re-upsert", async () => {
		await threadMessagesRepo.upsert(msg("m1"), "th1", "queued");
		await threadMessagesRepo.upsert(msg("m1"), "th1");

		expect((await threadMessagesRepo.getById("th1", "m1"))?.status).toBe(
			"queued",
		);

		await threadMessagesRepo.updateDeliveryStatus("m1", "read", ["bob:test"]);
		await threadMessagesRepo.upsert(
			{
				...msg("m1"),
				deliveryStatus: "delivered",
			},
			"th1",
		);

		const stored = await threadMessagesRepo.getById("th1", "m1");
		expect(stored?.deliveryStatus).toBe("read");
		expect(stored?.readBy).toEqual(["bob:test"]);
	});

	it("unions readers from both sides instead of dropping either", async () => {
		await threadMessagesRepo.upsert(
			{ ...msg("m1"), readBy: ["bob:test"] },
			"th1",
		);
		await threadMessagesRepo.upsert(
			{ ...msg("m1"), readBy: ["carol:test"] },
			"th1",
		);

		const stored = await threadMessagesRepo.getById("th1", "m1");
		expect(stored?.readBy?.sort()).toEqual(["bob:test", "carol:test"]);
	});
});
