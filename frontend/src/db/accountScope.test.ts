import { beforeEach, describe, expect, it } from "vitest";
import type { Chat } from "../types/api.ts";
import { chatsRepo } from "./chatsRepo.ts";
import { resetAllDBs, setActiveAccountKey } from "./init.ts";

const NOW = "2026-08-26T10:00:00.000Z";

function selfChat(userId: string, nick: string): Chat {
	return {
		id: `self-${userId}`,
		type: "self",
		name: "",
		ownerId: userId,
		members: [{ id: userId, nick }],
		createdAt: NOW,
	};
}

function privateChat(
	id: string,
	a: { id: string; nick: string },
	b: { id: string; nick: string },
): Chat {
	return {
		id,
		type: "private",
		name: "",
		ownerId: a.id,
		members: [a, b],
		createdAt: NOW,
	};
}

beforeEach(async () => {
	setActiveAccountKey(null);
	await resetAllDBs();
});

describe("per-account chat cache", () => {
	it("exposes only the active account's chats, with exactly one self chat", async () => {
		setActiveAccountKey("alice:test");
		await chatsRepo.upsertMany([
			selfChat("alice:test", "alice"),
			privateChat(
				"alice-bob",
				{ id: "alice:test", nick: "alice" },
				{ id: "bob:test", nick: "bob" },
			),
		]);

		setActiveAccountKey("bob:test");
		await chatsRepo.upsertMany([selfChat("bob:test", "bob")]);

		// While bob is active only bob's chats are visible.
		const bobChats = await chatsRepo.getAll();
		expect(bobChats).toHaveLength(1);
		expect(bobChats.filter((c) => c.type === "self")).toHaveLength(1);
		expect(bobChats.some((c) => c.id === "alice-bob")).toBe(false);

		// Switching back to alice restores her chats only — bob's self
		// chat must not leak into alice's list.
		setActiveAccountKey("alice:test");
		const aliceChats = await chatsRepo.getAll();
		expect(aliceChats).toHaveLength(2);
		expect(aliceChats.filter((c) => c.type === "self")).toHaveLength(1);
		expect(aliceChats.some((c) => c.id === "self-bob:test")).toBe(false);
	});

	it("starts empty for a brand-new account", async () => {
		setActiveAccountKey("carol:test");
		expect(await chatsRepo.getAll()).toEqual([]);
	});
});
