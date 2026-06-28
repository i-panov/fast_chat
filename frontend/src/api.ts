import { emitUnauthorized } from "./utils/authEvents.ts";

const HTTP_UNAUTHORIZED = 401;

async function request<T>(
	path: string,
	token: string | undefined,
	init?: RequestInit,
): Promise<T> {
	const headers: Record<string, string> = {};
	if (token !== undefined) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (!(init?.body instanceof FormData)) {
		headers["Content-Type"] = "application/json";
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
		throw new Error(`http ${res.status}: ${body.error ?? ""}`);
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
	type: "private" | "group";
	name: string;
	ownerId: string;
	avatarUrl?: string;
	members: MemberInfo[];
	createdAt: string;
}

export interface ReplyToInfo {
	messageId: string;
	text: string;
	fromNick: string;
	files?: FileInfo[];
	location?: Location;
}

export interface Location {
	lat: number;
	lng: number;
}

export interface FileInfo {
	id: string;
	mimeType: string;
	size: number;
	originalName: string;
	fileType: "photo" | "video" | "audio" | "file";
	url: string;
}

export interface PendingFile {
	id: string;
	file: File;
	blobUrl: string;
	originalName: string;
	size: number;
	mimeType: string;
	fileType: "photo" | "video" | "audio" | "file";
}

export type MessageStatus = "sent" | "queued" | "failed";

export interface Message {
	id: string;
	chatId: string;
	fromId: string;
	fromNick: string;
	text: string;
	createdAt: string;
	editedAt?: string;
	replyTo?: ReplyToInfo;
	files?: FileInfo[];
	location?: Location;
	status?: MessageStatus;
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

export type CreateChatOptions =
	| { type: "private"; withUserId: string }
	| { type: "group"; name: string; memberIds: string[] };

export function createChat(token: string, opts: CreateChatOptions) {
	return request<{ chat: Chat }>("/api/chats", token, {
		method: "POST",
		body: JSON.stringify(opts),
	});
}

export function getChatInfo(token: string, chatId: string) {
	return request<{ chat: Chat }>(`/api/chats/${chatId}`, token);
}

export function updateChat(
	token: string,
	chatId: string,
	body: { name?: string },
) {
	return request<{ chat: Chat }>(`/api/chats/${chatId}`, token, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

export function deleteChat(token: string, chatId: string) {
	return request<{ status: string }>(`/api/chats/${chatId}`, token, {
		method: "DELETE",
	});
}

export function addChatMember(token: string, chatId: string, userId: string) {
	return request<{ chat: Chat }>(`/api/chats/${chatId}/members`, token, {
		method: "POST",
		body: JSON.stringify({ userId }),
	});
}

export function removeChatMember(
	token: string,
	chatId: string,
	userId: string,
) {
	return request<{ chat: Chat }>(
		`/api/chats/${chatId}/members/${userId}`,
		token,
		{
			method: "DELETE",
		},
	);
}

export function uploadChatAvatar(
	token: string,
	chatId: string,
	fileId: string,
) {
	return request<{ chat: Chat }>(`/api/chats/${chatId}/avatar`, token, {
		method: "POST",
		body: JSON.stringify({ fileId }),
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

export function sendMessage(
	token: string,
	chatId: string,
	text: string,
	id: string,
	replyToId?: string,
	fileIDs?: string[],
	location?: Location,
) {
	return request<{ message: Message }>(`/api/chats/${chatId}/messages`, token, {
		method: "POST",
		body: JSON.stringify({ id, text, replyToId, fileIDs, location }),
	});
}

export function uploadFile(token: string, file: File) {
	const formData = new FormData();
	formData.append("file", file);

	return request<{ file: FileInfo }>("/api/files/upload", token, {
		method: "POST",
		body: formData,
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

export interface EditMessageOptions {
	location?: Location | null;
	clearLocation?: boolean;
}

export function editMessage(
	token: string,
	chatId: string,
	messageId: string,
	text: string,
	fileIDs?: string[],
	opts?: EditMessageOptions,
) {
	const body: {
		text: string;
		fileIDs?: string[];
		location?: Location | null;
	} = { text };

	if (fileIDs !== undefined) body.fileIDs = fileIDs;
	if (opts?.clearLocation) {
		body.location = null;
	} else if (opts?.location !== undefined) {
		body.location = opts.location;
	}

	return request<{ message: Message }>(
		`/api/chats/${chatId}/messages/${messageId}`,
		token,
		{ method: "PATCH", body: JSON.stringify(body) },
	);
}

export function editThreadMessage(
	token: string,
	chatId: string,
	threadId: string,
	messageId: string,
	text: string,
	fileIDs?: string[],
	opts?: EditMessageOptions,
) {
	const body: {
		text: string;
		fileIDs?: string[];
		location?: Location | null;
	} = { text };

	if (fileIDs !== undefined) body.fileIDs = fileIDs;
	if (opts?.clearLocation) {
		body.location = null;
	} else if (opts?.location !== undefined) {
		body.location = opts.location;
	}

	return request<{ message: Message }>(
		`/api/chats/${chatId}/threads/${threadId}/messages/${messageId}`,
		token,
		{ method: "PATCH", body: JSON.stringify(body) },
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

// biome-ignore lint/complexity/useMaxParams: all params are required for the thread-send payload
export function sendThreadMessage(
	token: string,
	chatId: string,
	threadId: string,
	text: string,
	id: string,
	replyToId?: string,
	fileIDs?: string[],
	location?: Location,
) {
	return request<{ message: Message }>(
		`/api/chats/${chatId}/threads/${threadId}/messages`,
		token,
		{
			method: "POST",
			body: JSON.stringify({ id, text, replyToId, fileIDs, location }),
		},
	);
}

export interface TypingPayload {
	chatId: string;
	userId: string;
	nick: string;
}

export function sendTyping(token: string, chatId: string, active: boolean) {
	return request<{ status: string }>(`/api/chats/${chatId}/typing`, token, {
		method: "POST",
		body: JSON.stringify({ active }),
	});
}

export function getConfig() {
	return request<AppConfig>("/api/config", undefined);
}

export interface SyncDeletedMessage {
	chatId: string;
	messageId: string;
	deletedAt: string;
}

export interface SyncDeletedChat {
	chatId: string;
	deletedAt: string;
}

export interface SyncResponse {
	serverNow: string;
	chats: Chat[];
	deletedChats: SyncDeletedChat[];
	messages: Message[];
	deletedMessages: SyncDeletedMessage[];
}

export function getSync(token: string, since: string): Promise<SyncResponse> {
	const params = new URLSearchParams({ since });
	return request<SyncResponse>(`/api/sync?${params.toString()}`, token);
}
