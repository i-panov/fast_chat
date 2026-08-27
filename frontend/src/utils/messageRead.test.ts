import { describe, expect, it } from "vitest";
import type { Message } from "../types/api.ts";
import {
	collectVisibleUnreadIds,
	type MessageListEntry,
} from "./messageRead.ts";

function msg(
	id: string,
	fromId: string,
	deliveryStatus?: Message["deliveryStatus"],
): Message {
	return {
		id,
		chatId: "c1",
		fromId,
		fromNick: fromId,
		text: "x",
		createdAt: "2026-01-01T00:00:00Z",
		deliveryStatus,
	};
}

function entries(msgs: Array<Message | null>): MessageListEntry[] {
	return msgs.map((m, i) =>
		m === null
			? { type: "separator", msg: msg(`sep-${i}`, "sep") }
			: { type: "message", msg: m },
	);
}

describe("collectVisibleUnreadIds", () => {
	it("collects other users' unread messages in the visible range", () => {
		const msgs = [
			msg("m1", "bob:test"),
			msg("m2", "alice:test"),
			msg("m3", "bob:test"),
		];

		const ids = collectVisibleUnreadIds(entries(msgs), 0, 2, "alice:test");
		expect(ids).toEqual(["m1", "m3"]);
	});

	it("skips already-read messages (breaks the re-read loop)", () => {
		const msgs = [
			msg("m1", "bob:test", "read"),
			msg("m2", "bob:test", "delivered"),
			msg("m3", "bob:test", "read"),
		];

		const ids = collectVisibleUnreadIds(entries(msgs), 0, 2, "alice:test");
		expect(ids).toEqual(["m2"]);
	});

	it("skips separator rows and respects the range boundaries", () => {
		const msgs = [
			null,
			msg("m1", "bob:test"),
			msg("m2", "bob:test"),
			msg("m3", "bob:test"),
		];

		// Only the middle slice [1..2] is visible.
		const ids = collectVisibleUnreadIds(entries(msgs), 1, 2, "alice:test");
		expect(ids).toEqual(["m1", "m2"]);
	});

	it("returns an empty list when everything visible is read or own", () => {
		const msgs = [msg("m1", "alice:test"), msg("m2", "bob:test", "read"), null];

		expect(collectVisibleUnreadIds(entries(msgs), 0, 2, "alice:test")).toEqual(
			[],
		);
	});
});
