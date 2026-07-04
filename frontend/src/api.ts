import type {
	AppConfig,
	Chat,
	CreateChatOptions,
	EditMessageOptions,
	FileInfo,
	Location,
	Message,
	SyncResponse,
	Thread,
	User,
	VerifyCodeResult,
} from "./types/api.ts";
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

export function sendCode(email: string) {
	return request<{ status: string; debugCode?: string }>(
		"/api/auth/send-code",
		undefined,
		{ method: "POST", body: JSON.stringify({ email }) },
	);
}

export function verifyCode(email: string, code: string) {
	return request<VerifyCodeResult>("/api/auth/verify-code", undefined, {
		method: "POST",
		body: JSON.stringify({ email, code }),
	});
}

export function completeRegistration(setupToken: string, nick: string) {
	return request<{ user: User; token: string; expiresAt: string }>(
		"/api/auth/complete-registration",
		undefined,
		{ method: "POST", body: JSON.stringify({ setupToken, nick }) },
	);
}

export function refreshToken(token: string) {
	return request<{ token: string; expiresAt: string }>(
		"/api/auth/refresh-token",
		token,
		{ method: "POST" },
	);
}

export function sseAuth(connectionId: string, token: string) {
	return request<{ status: string }>("/api/auth/sse-auth", undefined, {
		method: "POST",
		body: JSON.stringify({ connectionId, token }),
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

export interface GetMessagesQuery {
	limit?: number;
	before?: string;
	missingIDs?: string[];
}

export function getMessages(
	token: string,
	chatId: string,
	query: GetMessagesQuery = {},
) {
	return request<{ messages: Message[]; nextCursor?: string }>(
		`/api/chats/${chatId}/messages/query`,
		token,
		{
			method: "POST",
			body: JSON.stringify(query),
		},
	);
}

export interface SendMessageParams {
	chatId: string;
	text: string;
	id: string;
	replyToId?: string;
	fileIDs?: string[];
	location?: Location;
	threadId?: string;
}

export function sendMessage(token: string, params: SendMessageParams) {
	const path =
		params.threadId !== undefined
			? `/api/chats/${params.chatId}/threads/${params.threadId}/messages`
			: `/api/chats/${params.chatId}/messages`;
	return request<{ message: Message }>(path, token, {
		method: "POST",
		body: JSON.stringify({
			id: params.id,
			text: params.text,
			replyToId: params.replyToId,
			fileIDs: params.fileIDs,
			location: params.location,
		}),
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

export function markMessagesRead(
	token: string,
	chatId: string,
	messageIDs: string[],
) {
	return request<{ status: string }>("/api/messages/read", token, {
		method: "POST",
		body: JSON.stringify({ chatId, messageIDs }),
	});
}

export interface EditMessageParams {
	chatId: string;
	messageId: string;
	text: string;
	fileIDs?: string[];
	opts?: EditMessageOptions;
	threadId?: string;
}

function buildEditBody(params: EditMessageParams): Record<string, unknown> {
	const body: Record<string, unknown> = { text: params.text };
	if (params.fileIDs !== undefined) body.fileIDs = params.fileIDs;
	if (params.opts?.clearLocation) {
		body.location = null;
	} else if (params.opts?.location !== undefined) {
		body.location = params.opts.location;
	}
	return body;
}

export function editMessage(token: string, params: EditMessageParams) {
	const path =
		params.threadId !== undefined
			? `/api/chats/${params.chatId}/threads/${params.threadId}/messages/${params.messageId}`
			: `/api/chats/${params.chatId}/messages/${params.messageId}`;
	return request<{ message: Message }>(path, token, {
		method: "PATCH",
		body: JSON.stringify(buildEditBody(params)),
	});
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

export function sendTyping(token: string, chatId: string, active: boolean) {
	return request<{ status: string }>(`/api/chats/${chatId}/typing`, token, {
		method: "POST",
		body: JSON.stringify({ active }),
	});
}

export function getConfig() {
	return request<AppConfig>("/api/config", undefined);
}

export function getSync(token: string, since: string): Promise<SyncResponse> {
	const params = new URLSearchParams({ since });
	return request<SyncResponse>(`/api/sync?${params.toString()}`, token);
}

export function getVapidPublicKey() {
	return request<{ publicKey: string }>(
		"/api/push/vapid-public-key",
		undefined,
	);
}

export function subscribePush(
	token: string,
	endpoint: string,
	p256dh: string,
	auth: string,
) {
	return request<{ subscription: Record<string, unknown> }>(
		"/api/push/subscribe",
		token,
		{
			method: "POST",
			body: JSON.stringify({ endpoint, p256dh, auth }),
		},
	);
}

export function unsubscribePush(token: string, endpoint: string) {
	return request<{ status: string }>("/api/push/subscribe", token, {
		method: "DELETE",
		body: JSON.stringify({ endpoint }),
	});
}
