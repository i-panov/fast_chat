import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { threadsRepo } from "../db/threadsRepo.ts";
import { messageAAD } from "../e2ee/chat-encrypt.ts";
import {
	type EncryptedPayload,
	encryptContent,
	type KeyPair,
	sealMessageKey,
	signSenderBinding,
} from "../e2ee/crypto.ts";
import {
	confirmNewKey,
	ensureAccountKeys,
	ensureIdentityKeys,
} from "../e2ee/keys.ts";
import type { Message, Thread } from "../types/api.ts";
import { onNotification } from "../utils/notify.ts";

async function encryptThreadMessage(
	text: string,
	messageId: string,
	fromId: string,
	threadId?: string,
) {
	const identity = await ensureIdentityKeys();
	const binding = { chatId: "c1", messageId, fromId, threadId };
	const msgKey = crypto.getRandomValues(new Uint8Array(32));
	const aad = messageAAD(binding);
	const content = await encryptContent({ text }, msgKey, aad);
	const envelopes = await sealMessageKey(
		msgKey,
		[{ keyId: "alice:test", publicKey: keys.publicKey, keyVersion: 1 }],
		keys,
	);
	const payload: EncryptedPayload = {
		v: 3,
		nonce: content.nonce,
		senderKey: keys.publicKey,
		identityKey: identity.publicKey,
		identitySig: await signSenderBinding(identity, aad, keys.publicKey),
		envelopes,
	};
	return {
		text: content.ciphertext,
		encryptedPayload: JSON.stringify(payload),
	};
}

vi.mock("../api.ts", () => ({
	createThread: vi.fn(),
	getThreadMessages: vi.fn(),
	getThreads: vi.fn(),
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	getSessions: vi.fn(() =>
		Promise.resolve({
			currentSessionId: "s1",
			sessions: [{ id: "s1", current: true }],
		}),
	),
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

let scopeCounter = 0;

beforeEach(async () => {
	// A unique database per test: a local PIN/passkey lock left in the
	// shared scope would make the decryptors correctly blank all text.
	setActiveAccountKey(`alice-threads-${scopeCounter++}:test`);
	vi.clearAllMocks();
	mockApi().getThreads.mockResolvedValue({ threads: [] });
	mockApi().getThreadMessages.mockResolvedValue({ messages: [] });
	confirmNewKey();
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
		await waitFor(() => {
			expect(result.current.activeThreadMessages.map((m) => m.id)).toEqual([
				"m1",
				"m2",
			]);
		});

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
		const enc = await encryptThreadMessage(
			"reply secret",
			"tm1",
			"alice:test",
			"th-enc",
		);
		const parentEnc = await encryptThreadMessage(
			"parent secret",
			"p-enc",
			"alice:test",
		);

		await messagesRepo.upsertMany([
			{
				id: "p-enc",
				chatId: "c1",
				fromId: "alice:test",
				fromNick: "alice",
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
				fromId: "alice:test",
				fromNick: "alice",
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

	it("hides a deleted thread message and a tombstoned parent", async () => {
		await threadsRepo.upsert(thread("th-del", "p-del"));
		await messagesRepo.upsert({ ...plainMsg("p-del", "parent"), chatId: "c1" });
		await messagesRepo.applyDelete("c1", "p-del");
		await threadMessagesRepo.upsert(plainMsg("m-alive", "alive"), "th-del");
		await threadMessagesRepo.upsert(
			plainMsg("m-deleted", "should stay hidden"),
			"th-del",
		);
		await threadMessagesRepo.applyDelete("th-del", "m-deleted");

		const { result } = renderHook(() =>
			useThreads({ token: "tok", chatId: "c1" }),
		);

		act(() => {
			result.current.openThread("th-del");
		});

		await waitFor(() => {
			expect(result.current.activeThreadMessages.map((m) => m.id)).toEqual([
				"m-alive",
			]);
		});
		// The tombstone of the parent loses its preview instead of decrypting
		// the deleted text back onto the screen.
		await waitFor(() => {
			expect(result.current.activeThread?.parentMessageText).toBe("");
		});
	});
});
