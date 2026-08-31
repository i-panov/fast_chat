import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createThread,
	deleteChat,
	deleteMessage,
	editMessage,
	getConfig,
	getMessages,
	getSync,
	getThreadMessages,
	refreshToken,
	searchUsers,
	sendCode,
	sendMessage,
	sendTyping,
	uploadChatAvatar,
	uploadFile,
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
			location: { lat: 1, lng: 2 },
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
			location: { lat: 1, lng: 2 },
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
			opts: { clearLocation: true },
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = parseBody(init);
		expect(body.location).toBeNull();
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
});
