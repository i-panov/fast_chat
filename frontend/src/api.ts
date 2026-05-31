import { emitUnauthorized } from "./utils/authEvents.ts";

const HTTP_UNAUTHORIZED = 401;

async function request<T>(
	path: string,
	token: string | undefined,
	init?: RequestInit,
): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token !== undefined) {
		headers.Authorization = `Bearer ${token}`;
	}
	const res = await fetch(path, { ...init, headers });
	if (res.status === HTTP_UNAUTHORIZED) {
		if (token !== undefined) {
			emitUnauthorized(token);
		}
		throw new Error("unauthorized");
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as Record<string, string>;
		throw new Error(body.error ?? `HTTP ${String(res.status)}`);
	}
	return res.json() as Promise<T>;
}

export interface User {
	id: string;
	nick: string;
	online: boolean;
}

export interface MemberInfo {
	id: string;
	nick: string;
}

export interface Chat {
	id: string;
	members: MemberInfo[];
	createdAt: string;
}

export interface Message {
	id: string;
	chatId: string;
	fromId: string;
	fromNick: string;
	text: string;
	createdAt: string;
	editedAt?: string;
}

export interface Thread {
	id: string;
	chatId: string;
	parentMessageId: string;
	parentMessageText: string;
	parentMessageFrom: string;
	createdAt: string;
	messageCount: number;
}

export interface AppConfig {
	messageEditTTL: number;
	messageDeleteTTL: number;
}

export function register(nick: string) {
	return request<{ user: User; token: string }>("/api/register", undefined, {
		method: "POST",
		body: JSON.stringify({ nick }),
	});
}

export function searchUsers(token: string, q: string) {
	return request<{ users: User[] }>(
		`/api/users/search?q=${encodeURIComponent(q)}`,
		token,
	);
}

export function getChats(token: string) {
	return request<{ chats: Chat[] }>("/api/chats", token);
}

export function createChat(token: string, withUserId: string) {
	return request<{ chat: Chat }>("/api/chats", token, {
		method: "POST",
		body: JSON.stringify({ withUserId }),
	});
}

export function getMessages(
	token: string,
	chatId: string,
	limit?: number,
	before?: string,
) {
	const params = new URLSearchParams();
	if (limit !== undefined) params.set("limit", String(limit));
	if (before !== undefined) params.set("before", before);
	const qs = params.toString();

	return request<{ messages: Message[]; nextCursor?: string }>(
		`/api/chats/${chatId}/messages${qs ? `?${qs}` : ""}`,
		token,
	);
}

export function sendMessage(token: string, chatId: string, text: string, id: string) {
	return request<{ message: Message }>(`/api/chats/${chatId}/messages`, token, {
		method: "POST",
		body: JSON.stringify({ id, text }),
	});
}

export function deleteMessage(
	token: string,
	chatId: string,
	messageId: string,
) {
	return request<{ status: string }>(
		`/api/chats/${chatId}/messages/${messageId}`,
		token,
		{ method: "DELETE" },
	);
}

export function editMessage(
	token: string,
	chatId: string,
	messageId: string,
	text: string,
) {
	return request<{ message: Message }>(
		`/api/chats/${chatId}/messages/${messageId}`,
		token,
		{ method: "PATCH", body: JSON.stringify({ text }) },
	);
}

export function createThread(token: string, chatId: string, messageId: string) {
	return request<{ thread: Thread }>(
		`/api/chats/${chatId}/messages/${messageId}/thread`,
		token,
		{ method: "POST" },
	);
}

export function getThreadMessages(
	token: string,
	chatId: string,
	threadId: string,
	limit?: number,
	before?: string,
) {
	const params = new URLSearchParams();
	if (limit !== undefined) params.set("limit", String(limit));
	if (before !== undefined) params.set("before", before);
	const qs = params.toString();

	return request<{ messages: Message[]; nextCursor?: string }>(
		`/api/chats/${chatId}/threads/${threadId}/messages${qs ? `?${qs}` : ""}`,
		token,
	);
}

export function getThreads(token: string, chatId: string) {
	return request<{ threads: Thread[] }>(`/api/chats/${chatId}/threads`, token);
}

export function sendThreadMessage(
	token: string,
	chatId: string,
	threadId: string,
	text: string,
	id: string,
) {
	return request<{ message: Message }>(
		`/api/chats/${chatId}/threads/${threadId}/messages`,
		token,
		{ method: "POST", body: JSON.stringify({ id, text }) },
	);
}

export function getConfig() {
	return request<AppConfig>("/api/config", undefined);
}
