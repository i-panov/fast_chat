import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import type { Chat, Message } from "../types/api.ts";

vi.mock("../useSse.ts", () => ({
	useSse: vi.fn(),
}));

vi.mock("../sync/syncEngine.ts", () => ({
	scheduleSync: vi.fn(),
}));

const { useSse } = await import("../useSse.ts");
const { scheduleSync } = await import("../sync/syncEngine.ts");
const { useSseEvents } = await import("./useSseEvents.ts");

type Handler = (event: string, data: unknown) => Promise<void>;

function handler(): Handler {
	const calls = vi.mocked(useSse).mock.calls;
	if (calls.length === 0) throw new Error("useSse was not called");

	return calls[calls.length - 1][1] as Handler;
}

function baseParams(overrides: Record<string, unknown> = {}) {
	return {
		token: "tok",
		addTypingUser: vi.fn(),
		clearTyping: vi.fn(),
		onTokenExpiring: vi.fn(async (_t: string) => {}),
		onTokenExpired: vi.fn(),
		...overrides,
	};
}

function msg(id: string): Message {
	return {
		id,
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text: `text ${id}`,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function chat(): Chat {
	return {
		id: "c1",
		type: "group",
		name: "g",
		ownerId: "alice:test",
		members: [
			{ id: "alice:test", nick: "alice" },
			{ id: "bob:test", nick: "bob" },
		],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
});

describe("useSseEvents", () => {
	it("stores new and updated messages", async () => {
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("new_message", msg("m1"));
		await h("message_updated", { ...msg("m1"), text: "edited" });

		await waitFor(async () => {
			expect((await messagesRepo.getById("c1", "m1"))?.text).toBe("edited");
		});
	});

	it("deletes messages from the chat or the thread", async () => {
		await messagesRepo.upsertMany([msg("m1")]);
		await threadMessagesRepo.upsert(msg("tm1"), "th1");
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("message_deleted", { chatId: "c1", messageId: "m1" });
		await h("message_deleted", { chatId: "th1", messageId: "tm1" });

		await waitFor(async () => {
			expect((await messagesRepo.getById("c1", "m1"))?.status).toBe("deleted");
			expect(await threadMessagesRepo.getById("th1", "tm1")).toBeTruthy();
			expect((await threadMessagesRepo.getById("th1", "tm1"))?.status).toBe(
				"deleted",
			);
		});
	});

	it("routes thread deletions by messageId even with a real chatId", async () => {
		await threadMessagesRepo.upsert(msg("tm1"), "th1");
		// knownThreadIds is empty: the old chatId-based routing would have
		// deleted from the wrong store.
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("message_deleted", { chatId: "c1", messageId: "tm1" });

		await waitFor(async () => {
			expect((await threadMessagesRepo.getById("th1", "tm1"))?.status).toBe(
				"deleted",
			);
		});
	});

	it("does not clobber a queued message with an incoming SSE copy", async () => {
		await messagesRepo.upsert({ ...msg("m1"), text: "local queued" }, "queued");
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("new_message", msg("m1"));

		await waitFor(async () => {
			// The lifecycle stays queued so the outbox still finishes the
			// send; only the content follows the canonical server copy.
			const stored = await messagesRepo.getById("c1", "m1");
			expect(stored?.status).toBe("queued");
			expect(stored?.text).toBe("text m1");
		});
	});

	it("marks messages delivered in both stores", async () => {
		await messagesRepo.upsertMany([msg("m1")]);
		await threadMessagesRepo.upsert(msg("m1"), "th1");
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("message_delivered", { messageId: "m1" });

		await waitFor(async () => {
			expect((await messagesRepo.getById("c1", "m1"))?.deliveryStatus).toBe(
				"delivered",
			);
			expect(
				(await threadMessagesRepo.getById("th1", "m1"))?.deliveryStatus,
			).toBe("delivered");
		});
	});

	it("accumulates readers without duplicates", async () => {
		await messagesRepo.upsertMany([msg("m1")]);
		await threadMessagesRepo.upsert(msg("m1"), "th1");
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("message_read", { messageId: "m1", readerId: "bob:test" });
		await h("message_read", { messageId: "m1", readerId: "bob:test" });
		await h("message_read", { messageId: "m1", readerId: "carol:test" });

		await waitFor(async () => {
			expect((await messagesRepo.getById("c1", "m1"))?.readBy).toEqual([
				"bob:test",
				"carol:test",
			]);
			expect((await threadMessagesRepo.getById("th1", "m1"))?.readBy).toEqual([
				"bob:test",
				"carol:test",
			]);
		});
	});

	it("upserts chats on chat events and removes them on delete", async () => {
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		for (const event of [
			"chat_created",
			"chat_updated",
			"chat_member_added",
			"chat_member_removed",
		]) {
			await h(event, { ...chat(), name: `name ${event}` });
		}

		await waitFor(async () => {
			expect((await chatsRepo.getById("c1"))?.name).toBe(
				"name chat_member_removed",
			);
		});

		await h("chat_deleted", { chatId: "c1" });

		await waitFor(async () => {
			expect(await chatsRepo.getById("c1")).toBeUndefined();
		});
	});

	// The membership events carry the chat wrapped: { chatId, userId, chat }.
	// Reading the whole payload as a chat would write a record without an id.
	it("stores the chat of a membership event", async () => {
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("chat_member_added", {
			chatId: "c1",
			userId: "carol:test",
			chat: { ...chat(), name: "with carol" },
		});

		await waitFor(async () => {
			expect((await chatsRepo.getById("c1"))?.name).toBe("with carol");
		});
	});

	it("stores threads and thread messages", async () => {
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("thread_created", {
			id: "th1",
			chatId: "c1",
			parentMessageId: "p1",
			parentMessageText: "p",
			parentMessageFrom: "bob",
			createdAt: "2026-01-01T00:00:00Z",
			messageCount: 0,
		});
		await h("thread_message_new", { threadId: "th1", message: msg("tm1") });

		await waitFor(async () => {
			expect(await threadsRepo.getById("th1")).toBeTruthy();
			expect(await threadMessagesRepo.getById("th1", "tm1")).toBeTruthy();
		});
	});

	it("updates member presence", async () => {
		await chatsRepo.upsert(chat());
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("user_status_changed", { userId: "bob:test", online: true });

		await waitFor(async () => {
			const members = (await chatsRepo.getById("c1"))?.members ?? [];
			expect(members.find((m) => m.id === "bob:test")?.online).toBe(true);
		});
	});

	it("routes the call events to the call manager", async () => {
		const callManager = {
			handleIncoming: vi.fn(),
			handleAccepted: vi.fn(),
			handleEnded: vi.fn(),
			handleIce: vi.fn(),
		};

		renderHook(() => useSseEvents(baseParams({ callManager })));
		const h = handler();

		await h("call_incoming", {
			callId: "c-1",
			chatId: "chat-1",
			offer: "offer-sdp",
			from: { id: "bob:test", nick: "bob" },
		});
		await h("call_accepted", { callId: "c-1", answer: "a" });
		await h("call_ended", { callId: "c-1", reason: "hangup" });
		await h("call_ice", { callId: "c-1", candidate: {} });

		expect(callManager.handleIncoming).toHaveBeenCalledWith({
			callId: "c-1",
			chatId: "chat-1",
			offer: "offer-sdp",
			from: { id: "bob:test", nick: "bob" },
		});
		expect(callManager.handleAccepted).toHaveBeenCalledWith({
			callId: "c-1",
			answer: "a",
		});
		expect(callManager.handleEnded).toHaveBeenCalledWith({
			callId: "c-1",
			reason: "hangup",
		});
		expect(callManager.handleIce).toHaveBeenCalledWith({
			callId: "c-1",
			candidate: {},
		});
	});

	it("ignores the call events without a call manager", async () => {
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("call_incoming", { callId: "c-1" });
	});

	it("forwards typing events", async () => {
		const addTypingUser = vi.fn();
		const clearTyping = vi.fn();
		renderHook(() => useSseEvents(baseParams({ addTypingUser, clearTyping })));
		const h = handler();

		await h("typing", { chatId: "c1", userId: "bob:test", nick: "bob" });
		await h("typing_stop", { chatId: "c1", userId: "bob:test" });

		expect(addTypingUser).toHaveBeenCalledWith({
			chatId: "c1",
			userId: "bob:test",
			nick: "bob",
		});
		expect(clearTyping).toHaveBeenCalledWith("c1", "bob:test");
	});

	it("renews the token with the current value and signals expiry", async () => {
		const onTokenExpiring = vi.fn(async (_t: string) => {});
		const onTokenExpired = vi.fn();
		const { rerender } = renderHook(
			({ token }) =>
				useSseEvents(baseParams({ token, onTokenExpiring, onTokenExpired })),
			{ initialProps: { token: "t1" } },
		);
		rerender({ token: "t2" });
		const h = handler();

		await h("token_expiring", {});

		expect(onTokenExpiring).toHaveBeenCalledWith("t2");

		await h("token_expired", {});

		expect(onTokenExpired).toHaveBeenCalledTimes(1);
	});

	it("schedules a sync when the stream closes", async () => {
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("sse_closed", {});

		expect(vi.mocked(scheduleSync)).toHaveBeenCalledTimes(1);
	});

	it("ignores unknown events", async () => {
		renderHook(() => useSseEvents(baseParams()));
		const h = handler();

		await h("something_else", {});
	});
});
