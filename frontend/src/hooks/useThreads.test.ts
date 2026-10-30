import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import type { KeyPair } from "../e2ee/crypto.ts";
import { ensureAccountKeys } from "../e2ee/keys.ts";
import { encryptMessageText } from "../e2ee/message.ts";
import type { Message, Thread } from "../types/api.ts";
import { onNotification } from "../utils/notify.ts";

vi.mock("../api.ts", () => ({
	createThread: vi.fn(),
	getThreadMessages: vi.fn(),
	getThreads: vi.fn(),
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	setKeyBackup: vi.fn(),
	deleteKeyBackup: vi.fn(),
}));

vi.mock("../useAuth.tsx", () => ({
	useAuth: () => ({
		activeAccount: {
			user: { id: "alice:test", nick: "alice" },
			token: "tok",
			email: "alice@example.com",
			expiresAt: "2027-01-01T00:00:00Z",
		},
	}),
}));

const { createThread, getThreadMessages, getThreads } = await import(
	"../api.ts"
);
const { useThreads } = await import("./useThreads.ts");

function mockApi() {
	return {
		createThread: vi.mocked(createThread),
		getThreadMessages: vi.mocked(getThreadMessages),
		getThreads: vi.mocked(getThreads),
	};
}

function thread(id: string, parentMessageId: string): Thread {
	return {
		id,
		chatId: "c1",
		parentMessageId,
		parentMessageText: "server preview",
		parentMessageFrom: "bob",
		createdAt: "2026-01-01T00:00:00Z",
		messageCount: 1,
	};
}

function plainMsg(id: string, text: string): Message {
	return {
		id,
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

let keys: KeyPair;

beforeEach(async () => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
	mockApi().getThreads.mockResolvedValue({ threads: [] });
	mockApi().getThreadMessages.mockResolvedValue({ messages: [] });
	keys = await ensureAccountKeys("tok");
});

describe("useThreads", () => {
	it("builds the thread map and syncs server threads on mount", async () => {
		await threadsRepo.upsert(thread("th-local", "p1"));
		mockApi().getThreads.mockResolvedValue({
			threads: [thread("th-server", "p2")],
		});

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		await waitFor(() => {
			expect(result.current.threads["th-server"]).toBeTruthy();
		});
		expect(result.current.threads["th-local"]).toBeTruthy();
		expect(result.current.messageToThread).toEqual({
			p1: "th-local",
			p2: "th-server",
		});
		expect(mockApi().getThreads).toHaveBeenCalledWith("tok", "c1");
		expect(await threadsRepo.getById("th-server")).toBeTruthy();
	});

	it("does not fetch without a token or chat", () => {
		renderHook(() => useThreads({ token: undefined, chatId: "c1" }));
		renderHook(() => useThreads({ token: "tok", chatId: null }));

		expect(mockApi().getThreads).not.toHaveBeenCalled();
	});

	it("opens a thread, pages messages, and closes it", async () => {
		await threadsRepo.upsert(thread("th1", "p1"));
		const m1 = plainMsg("m1", "one");
		const m2 = plainMsg("m2", "two");
		mockApi()
			.getThreadMessages.mockResolvedValueOnce({
				messages: [m1],
				nextCursor: "cur1",
			})
			.mockResolvedValueOnce({ messages: [m2] });

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		act(() => {
			result.current.openThread("th1");
		});
		expect(result.current.activeThreadId).toBe("th1");

		await waitFor(() => {
			expect(result.current.threadHasMore).toBe(true);
		});
		expect(mockApi().getThreadMessages).toHaveBeenCalledWith(
			"tok",
			"c1",
			"th1",
			30,
		);

		await act(async () => {
			await result.current.loadMoreThreadMessages();
		});

		await waitFor(() => {
			expect(result.current.threadHasMore).toBe(false);
		});
		expect(mockApi().getThreadMessages).toHaveBeenLastCalledWith(
			"tok",
			"c1",
			"th1",
			30,
			"cur1",
		);
		expect(result.current.activeThreadMessages.map((m) => m.id)).toEqual([
			"m1",
			"m2",
		]);

		act(() => {
			result.current.closeThread();
		});
		expect(result.current.activeThreadId).toBeNull();
	});

	it("creates a thread on the server", async () => {
		const created = thread("th-new", "p9");
		mockApi().createThread.mockResolvedValueOnce({ thread: created });

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		await act(async () => {
			await result.current.createThread("c1", "p9");
		});

		await waitFor(() => {
			expect(result.current.activeThreadId).toBe("th-new");
		});
		expect(await threadsRepo.getById("th-new")).toBeTruthy();
	});

	it("falls back to the existing thread on create conflict", async () => {
		const existing = thread("th-old", "p9");
		mockApi().createThread.mockRejectedValueOnce(new Error("409"));
		// Persistent (not Once): the mount effect also calls getThreads.
		mockApi().getThreads.mockResolvedValue({ threads: [existing] });

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		await act(async () => {
			await result.current.createThread("c1", "p9");
		});

		await waitFor(() => {
			expect(result.current.activeThreadId).toBe("th-old");
		});
	});

	it("notifies when creation fails entirely", async () => {
		mockApi().createThread.mockRejectedValueOnce(new Error("500"));
		mockApi().getThreads.mockResolvedValueOnce({ threads: [] });
		const seen: string[] = [];
		const off = onNotification((n) => seen.push(n.message));

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		await act(async () => {
			await result.current.createThread("c1", "p9");
		});

		await waitFor(() => {
			expect(seen).toHaveLength(1);
		});
		off();
	});

	it("decrypts thread messages and the encrypted parent text", async () => {
		const enc = await encryptMessageText("reply secret", [
			{ keyId: "alice:test", publicKey: keys.publicKey },
		]);
		const parentEnc = await encryptMessageText("parent secret", [
			{ keyId: "alice:test", publicKey: keys.publicKey },
		]);

		await messagesRepo.upsertMany([
			{
				id: "p-enc",
				chatId: "c1",
				fromId: "bob:test",
				fromNick: "bob",
				text: parentEnc.text,
				encrypted: true,
				encryptedPayload: parentEnc.encryptedPayload,
				createdAt: "2026-01-01T00:00:00Z",
			},
		]);
		await threadsRepo.upsert(thread("th-enc", "p-enc"));
		await threadMessagesRepo.upsert(
			{
				id: "tm1",
				chatId: "c1",
				fromId: "bob:test",
				fromNick: "bob",
				text: enc.text,
				encrypted: true,
				encryptedPayload: enc.encryptedPayload,
				createdAt: "2026-01-01T00:00:01Z",
			},
			"th-enc",
		);

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		act(() => {
			result.current.openThread("th-enc");
		});

		await waitFor(() => {
			expect(result.current.activeThreadMessages.map((m) => m.text)).toEqual([
				"reply secret",
			]);
		});
		await waitFor(() => {
			expect(result.current.activeThread?.parentMessageText).toBe(
				"parent secret",
			);
		});
	});

	it("fetches on open even with cached messages", async () => {
		await threadsRepo.upsert(thread("th-cached", "p1"));
		await threadMessagesRepo.upsert(
			plainMsg("m-cached", "cached"),
			"th-cached",
		);
		mockApi().getThreadMessages.mockResolvedValueOnce({
			messages: [plainMsg("m-new", "new")],
			nextCursor: "cur1",
		});

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		act(() => {
			result.current.openThread("th-cached");
		});

		// A non-empty IDB cache must not skip the initial fetch: without it
		// hasMore is set from an unknown cursor and loadMore can never run.
		await waitFor(() => {
			expect(mockApi().getThreadMessages).toHaveBeenCalledWith(
				"tok",
				"c1",
				"th-cached",
				30,
			);
		});
		await waitFor(() => {
			expect(result.current.threadHasMore).toBe(true);
		});
		expect(result.current.activeThreadMessages.map((m) => m.id)).toContain(
			"m-new",
		);
	});
});
