import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { Message } from "../types/api.ts";
import { useLocalMessageSearch } from "./useLocalMessageSearch.ts";

function message(id: string, text: string): Message {
	return {
		id,
		chatId: "search-chat",
		fromId: "bob:test",
		fromNick: "bob",
		text,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

beforeEach(async () => {
	setActiveAccountKey("alice:test");
	await chatsRepo.upsert({
		id: "search-chat",
		type: "group",
		name: "Search chat",
		ownerId: "alice:test",
		members: [
			{ id: "alice:test", nick: "alice" },
			{ id: "bob:test", nick: "bob" },
		],
		createdAt: "2026-01-01T00:00:00Z",
	});
	await messagesRepo.upsertMany([
		message("search-m1", "hello world"),
		message("search-m2", "another message"),
	]);
});

describe("useLocalMessageSearch", () => {
	it("finds decrypted local messages by substring", async () => {
		const { result } = renderHook(() => useLocalMessageSearch("alice:test"));

		act(() => {
			result.current.setQuery("hello");
		});

		await waitFor(() => {
			expect(result.current.results).toHaveLength(1);
		});
		expect(result.current.results[0]?.message.text).toBe("hello world");
		expect(result.current.results[0]?.chatTitle).toBe("Search chat");
	});
});
