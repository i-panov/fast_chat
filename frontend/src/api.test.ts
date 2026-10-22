import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acceptCall,
	addChatMember,
	completeRegistration,
	createChat,
	createThread,
	deleteChat,
	deleteKeyBackup,
	deleteMessage,
	editMessage,
	fileExistsByHash,
	getChatInfo,
	getConfig,
	getCurrentCall,
	getIceServers,
	getKeyBackup,
	getMessages,
	getPublicKey,
	getSync,
	getThreadMessages,
	getThreads,
	getVapidPublicKey,
	hangupCall,
	markMessagesRead,
	refreshToken,
	rejectCall,
	removeChatMember,
	searchUsers,
	sendCallIce,
	sendCode,
	sendMessage,
	sendTyping,
	setKeyBackup,
	sseAuth,
	startCall,
	subscribePush,
	updateChat,
	uploadChatAvatar,
	uploadFile,
	uploadPublicKey,
	verifyCode,
} from "./api.ts";
import { onUnauthorized } from "./utils/authEvents.ts";

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: () => Promise.resolve(body),
		headers: { get: (key: string) => headers[key] ?? null },
	};
}

function parseBody(init: RequestInit): Record<string, unknown> {
	if (typeof init.body !== "string") {
		throw new Error("expected a JSON string request body");
	}
	return JSON.parse(init.body) as Record<string, unknown>;
}

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("request()", () => {
	it("sends a Bearer token and JSON content-type", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

		await refreshToken("tok-123");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/auth/refresh-token");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok-123",
		);
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
			"application/json",
		);
	});

	it("omits Authorization when called without a token", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "sent" }));

		await sendCode("a@b.c");

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("does not set JSON content-type for FormData bodies", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { file: {} }));

		await uploadFile("tok", new File(["x"], "a.txt"));

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.body).toBeInstanceOf(FormData);
		const headers = init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBeUndefined();
		expect(headers.Authorization).toBe("Bearer tok");
	});

	it("carries the error body and Retry-After suffix on non-ok responses", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(429, { error: "slow down" }, { "Retry-After": "5" }),
		);

		await expect(refreshToken("tok")).rejects.toThrow(
			"http 429: slow down retry-after:5",
		);
	});

	it("throws unauthorized on 401 with a token and emits the event", async () => {
		const unauthSpy = vi.fn();
		const off = onUnauthorized(unauthSpy);
		fetchMock.mockResolvedValue(jsonResponse(401, { error: "nope" }));

		await expect(refreshToken("tok-1")).rejects.toThrow("unauthorized");
		expect(unauthSpy).toHaveBeenCalledWith("tok-1");
		off();
	});

	it("throws unauthorized on 401 without a token but does not emit", async () => {
		const unauthSpy = vi.fn();
		const off = onUnauthorized(unauthSpy);
		fetchMock.mockResolvedValue(jsonResponse(401, {}));

		await expect(sendCode("a@b.c")).rejects.toThrow("unauthorized");
		expect(unauthSpy).not.toHaveBeenCalled();
		off();
	});
});

describe("endpoint helpers", () => {
	it("getSync encodes the since cursor into the query", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				serverNow: "2026-01-01T00:00:00Z",
				chats: [],
				deletedChats: [],
				messages: [],
				deletedMessages: [],
			}),
		);

		await getSync("tok", "2026-08-30T10:00:00.000Z");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/sync?since=2026-08-30T10%3A00%3A00.000Z");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);
	});

	it("searchUsers percent-encodes the query", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { users: [] }));

		await searchUsers("tok", "a b&c");

		const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
		// biome-ignore lint/security/noSecrets: URL fixture asserting percent-encoding, not a secret
		expect(path).toBe("/api/users/search?q=a%20b%26c");
	});

	it("sendMessage posts to the chat endpoint with the payload", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { message: {} }));

		await sendMessage("tok", {
			chatId: "chat-1",
			text: "hi",
			id: "m1",
			replyToId: "m0",
			fileIDs: ["f1"],
		});

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1/messages");
		expect(init.method).toBe("POST");
		expect(parseBody(init)).toEqual({
			id: "m1",
			text: "hi",
			replyToId: "m0",
			fileIDs: ["f1"],
		});
	});

	it("sendMessage routes thread messages to the thread endpoint", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { message: {} }));

		await sendMessage("tok", {
			chatId: "chat-1",
			text: "hi",
			id: "m1",
			threadId: "t1",
		});

		const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1/threads/t1/messages");
	});

	it("editMessage clears location when clearLocation is set", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { message: {} }));

		await editMessage("tok", {
			chatId: "chat-1",
			messageId: "m1",
			text: "edited",
			clearLocation: true,
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = parseBody(init);
		expect(body.clearLocation).toBe(true);
		expect(body.text).toBe("edited");
	});

	it("editMessage passes encrypted flag and payload", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { message: {} }));

		await editMessage("tok", {
			chatId: "chat-1",
			messageId: "m1",
			text: "secret",
			encrypted: true,
			encryptedPayload: "cipher",
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = parseBody(init);
		expect(body.encrypted).toBe(true);
		expect(body.encryptedPayload).toBe("cipher");
	});

	it("deleteMessage issues a DELETE", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await deleteMessage("tok", "chat-1", "m1");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1/messages/m1");
		expect(init.method).toBe("DELETE");
	});

	it("deleteChat issues a DELETE on the chat", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await deleteChat("tok", "chat-1");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1");
		expect(init.method).toBe("DELETE");
	});

	it("uploadChatAvatar posts the file id", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { chat: {} }));

		await uploadChatAvatar("tok", "chat-1", "file-9");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1/avatar");
		expect(parseBody(init)).toEqual({ fileId: "file-9" });
	});

	it("getMessages posts the query body", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { messages: [] }));

		await getMessages("tok", "chat-1", {
			limit: 50,
			before: "x",
			missingIDs: ["m1"],
		});

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1/messages/query");
		expect(parseBody(init)).toEqual({
			limit: 50,
			before: "x",
			missingIDs: ["m1"],
		});
	});

	it("getThreadMessages appends query params", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { messages: [] }));

		await getThreadMessages("tok", "chat-1", "t1", 30, "cur");

		const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe(
			// biome-ignore lint/security/noSecrets: URL fixture with query params, not a secret
			"/api/chats/chat-1/threads/t1/messages?limit=30&before=cur",
		);
	});

	it("createThread POSTs the thread endpoint", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { thread: {} }));

		await createThread("tok", "chat-1", "m1");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1/messages/m1/thread");
		expect(init.method).toBe("POST");
	});

	it("sendTyping posts active state", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await sendTyping("tok", "chat-1", true);

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/chats/chat-1/typing");
		expect(parseBody(init)).toEqual({ active: true });
	});

	it("getConfig requests without a token", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { messageEditTTL: 300 }));

		await getConfig();

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("parses the JSON body of successful responses", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { status: "sent", debugCode: "123456" }),
		);

		const result = await sendCode("a@b.c");
		expect(result.debugCode).toBe("123456");
	});

	it("reports the status without a Retry-After suffix", async () => {
		fetchMock.mockResolvedValue(jsonResponse(500, { error: "boom" }));

		await expect(refreshToken("tok")).rejects.toThrow("http 500: boom");
	});

	it("tolerates a non-JSON error body", async () => {
		fetchMock.mockResolvedValue({
			status: 500,
			ok: false,
			json: () => Promise.reject(new Error("not json")),
			headers: { get: () => null },
		});

		await expect(refreshToken("tok")).rejects.toThrow("http 500: ");
	});

	it("verifies codes for new and existing accounts", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { isNew: true, setupToken: "st" }),
		);
		expect(await verifyCode("a@b.c", "123456")).toEqual({
			isNew: true,
			setupToken: "st",
		});

		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				isNew: false,
				user: { id: "u", nick: "n", online: true },
				token: "t",
				expiresAt: "e",
			}),
		);
		const existing = await verifyCode("a@b.c", "123456");
		expect(existing).toEqual({
			isNew: false,
			user: { id: "u", nick: "n", online: true },
			token: "t",
			expiresAt: "e",
		});
	});

	it("completes registration and authenticates streams", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { user: {}, token: "t", expiresAt: "e" }),
		);

		await completeRegistration("setup", "nick");
		const [, regInit] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(parseBody(regInit)).toEqual({ setupToken: "setup", nick: "nick" });

		await sseAuth("conn-1", "tok");
		const [authPath, authInit] = fetchMock.mock.calls[1] as [
			string,
			RequestInit,
		];
		expect(authPath).toBe("/api/auth/sse-auth");
		expect(parseBody(authInit)).toEqual({
			connectionId: "conn-1",
			token: "tok",
		});
	});

	it("creates private and group chats", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { chat: {} }));

		await createChat("tok", { type: "private", withUserId: "u1" });
		await createChat("tok", { type: "group", name: "g", memberIds: ["u1"] });

		const [, privInit] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(parseBody(privInit)).toEqual({ type: "private", withUserId: "u1" });
		const [, groupInit] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(parseBody(groupInit)).toEqual({
			type: "group",
			name: "g",
			memberIds: ["u1"],
		});
	});

	it("reads and mutates chats and members", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { chat: { id: "c1" } }));

		await getChatInfo("tok", "c1");
		await updateChat("tok", "c1", { name: "new" });
		await addChatMember("tok", "c1", "u2");
		await removeChatMember("tok", "c1", "u2");

		const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
		expect(calls[0][0]).toBe("/api/chats/c1");
		expect(calls[0][1].method).toBeUndefined();
		expect(calls[1][0]).toBe("/api/chats/c1");
		expect(calls[1][1].method).toBe("PATCH");
		expect(parseBody(calls[1][1])).toEqual({ name: "new" });
		expect(calls[2][0]).toBe("/api/chats/c1/members");
		expect(calls[2][1].method).toBe("POST");
		expect(calls[3][0]).toBe("/api/chats/c1/members/u2");
		expect(calls[3][1].method).toBe("DELETE");
	});

	it("manages keys and backups", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await uploadPublicKey("tok", "pub");
		await setKeyBackup("tok", "blob");

		fetchMock.mockResolvedValue(jsonResponse(200, { publicKey: "pub" }));
		expect(await getPublicKey("tok", "u1")).toEqual({ publicKey: "pub" });

		fetchMock.mockResolvedValue(jsonResponse(200, { backup: "blob" }));
		expect(await getKeyBackup("tok")).toEqual({ backup: "blob" });

		await deleteKeyBackup("tok");
		const [delPath, delInit] = fetchMock.mock.calls[4] as [string, RequestInit];
		expect(delPath).toBe("/api/users/key-backup");
		expect(delInit.method).toBe("DELETE");
	});

	it("uploads files with dedup metadata", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { file: {} }));

		await uploadFile("tok", new File(["x"], "a.txt"), "hash-1", true);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const form = init.body as FormData;
		expect(form.get("hash")).toBe("hash-1");
		expect(form.get("encrypted")).toBe("true");
	});

	it("checks file existence by hash", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { exists: true }));
		expect(await fileExistsByHash("tok", "a b")).toBe(true);

		const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
		// biome-ignore lint/security/noSecrets: URL fixture with an encoded hash, not a secret
		expect(path).toBe("/api/files/exists?hash=a%20b");

		fetchMock.mockResolvedValue(jsonResponse(200, { exists: false }));
		expect(await fileExistsByHash("tok", "a b")).toBe(false);
	});

	it("marks messages read", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await markMessagesRead("tok", "c1", ["m1", "m2"]);

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/messages/read");
		expect(parseBody(init)).toEqual({ chatId: "c1", messageIDs: ["m1", "m2"] });
	});

	it("fetches threads and push metadata", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { threads: [] }));
		await getThreads("tok", "c1");
		expect(fetchMock.mock.calls[0][0]).toBe("/api/chats/c1/threads");

		fetchMock.mockResolvedValue(jsonResponse(200, { publicKey: "vapid" }));
		expect(await getVapidPublicKey()).toEqual({ publicKey: "vapid" });

		fetchMock.mockResolvedValue(jsonResponse(200, { subscription: {} }));
		await subscribePush("tok", "ep", "p256", "auth");
		const [, subInit] = fetchMock.mock.calls[2] as [string, RequestInit];
		expect(parseBody(subInit)).toEqual({
			endpoint: "ep",
			p256dh: "p256",
			auth: "auth",
		});
	});
});

describe("calls", () => {
	it("starts a call in a chat", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(201, { callId: "c-1", state: "ringing" }),
		);

		const result = await startCall("tok", "chat-1", "v=0");

		expect(result.callId).toBe("c-1");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/calls");
		expect(init.method).toBe("POST");
		expect(parseBody(init)).toEqual({ chatId: "chat-1", offer: "v=0" });
	});

	it("accepts a call with the answer", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { callId: "c-1", state: "active" }),
		);

		await acceptCall("tok", "c-1", "answer-sdp");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/calls/c-1/accept");
		expect(parseBody(init)).toEqual({ answer: "answer-sdp" });
	});

	it("rejects a call", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await rejectCall("tok", "c-1");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/calls/c-1/reject");
		expect(init.method).toBe("POST");
	});

	it("ends a call", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await hangupCall("tok", "c-1", "peer-left");

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/calls/c-1/hangup");
		expect(parseBody(init)).toEqual({ reason: "peer-left" });
	});

	it("forwards an ICE candidate", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

		await sendCallIce("tok", "c-1", { candidate: "candidate-data" });

		const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(path).toBe("/api/calls/c-1/ice");
		expect(parseBody(init)).toEqual({
			candidate: { candidate: "candidate-data" },
		});
	});

	it("reads the current call", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { callId: "c-1", peer: "bob", state: "active" }),
		);

		const call = await getCurrentCall("tok");

		expect(call.state).toBe("active");
		expect(fetchMock.mock.calls[0][0]).toBe("/api/calls/current");
	});

	it("reads the ICE configuration", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { stun: ["stun:stun.test"], turn: [] }),
		);

		const config = await getIceServers("tok");

		expect(config.stun).toEqual(["stun:stun.test"]);
		expect(fetchMock.mock.calls[0][0]).toBe("/api/ice");
	});
});
