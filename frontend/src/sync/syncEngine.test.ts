import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import type { SyncResponse } from "../types/api.ts";
import {
	retryFailedOps,
	runSync,
	scheduleSync,
	setTokenProvider,
	subscribeSyncState,
} from "./syncEngine.ts";

vi.mock("../api.ts", () => ({
	getSync: vi.fn(),
	sendMessage: vi.fn(),
	editMessage: vi.fn(),
	deleteMessage: vi.fn(),
	uploadFile: vi.fn(),
}));

import type { Mock } from "vitest";
import { getSync } from "../api.ts";

const getSyncMock = getSync as Mock;

const syncResponse = (overrides: Partial<SyncResponse> = {}): SyncResponse => ({
	serverNow: "2026-08-30T11:00:00.000Z",
	chats: [],
	deletedChats: [],
	messages: [],
	deletedMessages: [],
	...overrides,
});

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
	setTokenProvider(() => "tok");
	getSyncMock.mockResolvedValue(syncResponse());
});

afterEach(() => {
	setTokenProvider(() => null);
	vi.restoreAllMocks();
});

describe("runSync", () => {
	it("no-ops without a token", async () => {
		setTokenProvider(() => null);

		await runSync();

		expect(getSyncMock).not.toHaveBeenCalled();
	});

	it("no-ops offline", async () => {
		Object.defineProperty(navigator, "onLine", {
			value: false,
			configurable: true,
		});

		await runSync();

		expect(getSyncMock).not.toHaveBeenCalled();

		Object.defineProperty(navigator, "onLine", {
			value: true,
			configurable: true,
		});
	});

	it("syncs messages and records serverNow", async () => {
		getSyncMock.mockResolvedValue(
			syncResponse({
				messages: [
					{
						id: "m1",
						chatId: "chat-1",
						fromId: "alice:test",
						fromNick: "alice",
						text: "hi",
						createdAt: "2026-08-30T10:00:00.000Z",
					},
				],
			}),
		);

		await runSync();

		expect(getSyncMock).toHaveBeenCalledWith("tok", "1970-01-01T00:00:00.000Z");
		const during = await messagesRepo.getByChat("chat-1");
		expect(during[0].text).toBe("hi");
		expect(await metaRepo.getLastSyncedAt()).toBe("2026-08-30T11:00:00.000Z");
	});

	it("notifies listeners with syncing/idle transitions", async () => {
		const states: string[] = [];
		const unsub = subscribeSyncState((s) => states.push(s));

		await runSync();

		unsub();
		expect(states).toEqual(["syncing", "idle"]);
	});

	it("treats a transient server error as idle with a cleared error", async () => {
		// fake-indexeddb relies on real macrotasks, so fake timers are out.
		// Capture the retry setTimeout instead and assert it was scheduled.
		const originalSetTimeout = globalThis.setTimeout;
		let retryScheduled = 0;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((cb, ms) => {
			if (typeof cb === "function" && ms === 5000) retryScheduled += 1;
			return originalSetTimeout(cb, ms);
		});

		getSyncMock.mockRejectedValue(new Error("http 500: boom"));

		await runSync();

		expect((await import("./syncEngine.ts")).getSyncState()).toBe("idle");
		expect((await import("./syncEngine.ts")).getLastSyncError()).toBeNull();
		expect(retryScheduled).toBeGreaterThan(0);
	});

	it("treats a definitive client error as a terminal error state", async () => {
		getSyncMock.mockRejectedValue(new Error("http 400: bad"));

		await runSync();

		const lastError = (await import("./syncEngine.ts")).getLastSyncError();
		expect(lastError).toBeInstanceOf(Error);
		expect((lastError as Error).message).toBe("http 400: bad");
		expect((await import("./syncEngine.ts")).getSyncState()).toBe("error");
	});

	it("clears the error on the next successful sync", async () => {
		getSyncMock.mockRejectedValueOnce(new Error("http 400: bad"));
		getSyncMock.mockResolvedValueOnce(syncResponse());

		await runSync();
		expect((await import("./syncEngine.ts")).getLastSyncError()).toBeTruthy();

		await runSync();
		expect((await import("./syncEngine.ts")).getLastSyncError()).toBeNull();
		expect((await import("./syncEngine.ts")).getSyncState()).toBe("idle");
	});

	it("treats unauthorized as a terminal error", async () => {
		getSyncMock.mockRejectedValue(new Error("unauthorized"));

		await runSync();

		expect((await import("./syncEngine.ts")).getSyncState()).toBe("error");
		expect((await import("./syncEngine.ts")).getLastSyncError()).toBeTruthy();
	});

	it("treats network failures as transient", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		let retryScheduled = 0;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((cb, ms) => {
			if (typeof cb === "function" && ms === 5000) retryScheduled += 1;
			return originalSetTimeout(cb, ms);
		});

		getSyncMock.mockRejectedValue(new Error("fetch failed"));

		await runSync();

		expect((await import("./syncEngine.ts")).getSyncState()).toBe("idle");
		expect(retryScheduled).toBeGreaterThan(0);
	});

	it("honours Retry-After on 429", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const scheduled: number[] = [];
		vi.spyOn(globalThis, "setTimeout").mockImplementation((cb, ms) => {
			if (typeof cb === "function" && typeof ms === "number") {
				scheduled.push(ms);
			}
			return originalSetTimeout(cb, ms);
		});

		getSyncMock.mockRejectedValue(new Error("http 429: slow retry-after:1"));

		await runSync();

		expect(scheduled).toContain(1000);
	});

	it("coalesces concurrent runs into one rerun", async () => {
		let resolveFirst!: (v: SyncResponse) => void;
		getSyncMock.mockReturnValueOnce(
			new Promise<SyncResponse>((resolve) => {
				resolveFirst = resolve;
			}),
		);

		const first = runSync();
		await runSync();
		resolveFirst(syncResponse());
		await first;
		// Let the scheduled rerun fire.
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 50));

		expect(getSyncMock.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("debounces scheduled syncs", async () => {
		const originalClearTimeout = globalThis.clearTimeout;
		const cleared: unknown[] = [];
		vi.spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
			cleared.push(id);
			return originalClearTimeout(id);
		});

		scheduleSync();
		scheduleSync();
		scheduleSync();

		// The first call arms the timer; the next two cancel and re-arm it.
		expect(cleared).toHaveLength(2);
		// Let the debounced run finish for cleanliness.
		await new Promise((r) => setTimeout(r, 1200));
	});
});

describe("retryFailedOps", () => {
	it("resets failed ops to pending and marks messages queued", async () => {
		await messagesRepo.upsert(
			{
				id: "m1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "hello",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"failed",
		);
		await outboxRepo.enqueue({
			kind: "send",
			opId: "failed-send",
			chatId: "chat-1",
			msgId: "m1",
			text: "hello",
			pendingFileClientIds: [],
			createdAt: "2026-08-30T09:00:00.000Z",
			attempts: 3,
			status: "failed",
		});

		await retryFailedOps();

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(1);
		expect(ops[0].status).toBeUndefined();
		expect(ops[0].attempts).toBe(0);

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.status).toBe("queued");
	});

	it("ignores failed delete ops and pending ops", async () => {
		await outboxRepo.enqueue({
			kind: "delete",
			opId: "failed-del",
			chatId: "chat-1",
			messageId: "m1",
			createdAt: "2026-08-30T09:00:00.000Z",
			attempts: 1,
			status: "failed",
		});
		await outboxRepo.enqueue({
			kind: "send",
			opId: "pending-send",
			chatId: "chat-1",
			msgId: "m2",
			text: "x",
			pendingFileClientIds: [],
			createdAt: "2026-08-30T09:00:00.000Z",
			attempts: 0,
		});

		await retryFailedOps();

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(2);
		expect(ops.find((o) => o.opId === "failed-del")?.status).toBe("failed");
		expect(ops.find((o) => o.opId === "pending-send")?.status).toBeUndefined();
	});

	it("resets failed thread ops to pending and marks them queued", async () => {
		const { threadMessagesRepo } = await import("../db/threadMessagesRepo.ts");
		await threadMessagesRepo.upsert(
			{
				id: "tm1",
				chatId: "chat-1",
				fromId: "alice:test",
				fromNick: "alice",
				text: "hello",
				createdAt: "2026-08-30T09:00:00.000Z",
			},
			"th1",
			"failed",
		);
		await outboxRepo.enqueue({
			kind: "send",
			opId: "failed-thread-send",
			chatId: "chat-1",
			msgId: "tm1",
			threadId: "th1",
			text: "hello",
			pendingFileClientIds: [],
			createdAt: "2026-08-30T09:00:00.000Z",
			attempts: 2,
			status: "failed",
		});

		await retryFailedOps();

		expect((await threadMessagesRepo.getById("th1", "tm1"))?.status).toBe(
			"queued",
		);
	});
});
