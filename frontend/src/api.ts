import type {
	AppConfig,
	Chat,
	CreateChatOptions,
	EditMessageOptions,
	FileInfo,
	Message,
	SyncResponse,
	Thread,
	User,
	VerifyCodeResult,
} from "./types/api.ts";
import { emitUnauthorized } from "./utils/authEvents.ts";

const HTTP_UNAUTHORIZED = 401;
const KEY_BACKUP_ENDPOINT = "/api/users/key-backup";

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
		const retryAfter = res.headers.get("Retry-After");
		const suffix = retryAfter !== null ? ` retry-after:${retryAfter}` : "";
		throw new Error(`http ${res.status}: ${body.error ?? ""}${suffix}`);
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

// revokeSession revokes the session token on the server. The local session
// is removed by the caller; the call is best effort, because a logout that
// fails on the network must still end the session locally.
export async function revokeSession(token: string): Promise<void> {
	try {
		await request<{ status: string }>("/api/auth/logout", token, {
			method: "POST",
		});
	} catch {
		// The token stays valid until it expires; the local session is gone
		// either way.
	}
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
	fileHashes?: string[];
	threadId?: string;
	encrypted?: boolean;
	encryptedPayload?: string;
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
			fileHashes: params.fileHashes,
			encrypted: params.encrypted,
			encryptedPayload: params.encryptedPayload,
		}),
	});
}

export function uploadPublicKey(token: string, publicKey: string) {
	return request<{ status: string }>("/api/users/public-key", token, {
		method: "PUT",
		body: JSON.stringify({ publicKey }),
	});
}

export function getPublicKey(token: string, userId: string) {
	return request<{ publicKey: string; keyVersion?: string }>(
		`/api/users/${encodeURIComponent(userId)}/public-key`,
		token,
	);
}

export function setKeyBackup(token: string, backup: string) {
	return request<{ status: string }>(KEY_BACKUP_ENDPOINT, token, {
		method: "PUT",
		body: JSON.stringify({ backup }),
	});
}

export function getKeyBackup(token: string) {
	return request<{ backup: string }>(KEY_BACKUP_ENDPOINT, token);
}

export function deleteKeyBackup(token: string) {
	return request<{ status: string }>(KEY_BACKUP_ENDPOINT, token, {
		method: "DELETE",
	});
}

export function uploadFile(
	token: string,
	file: File,
	plaintextHash?: string,
	encrypted = false,
) {
	const formData = new FormData();
	formData.append("file", file);
	// The plaintext hash lets the server deduplicate encrypted files without
	// ever seeing the plaintext. Required when encrypted is true.
	if (plaintextHash !== undefined) {
		formData.append("hash", plaintextHash);
	}
	if (encrypted) {
		formData.append("encrypted", "true");
	}

	return request<{ file: FileInfo }>("/api/files/upload", token, {
		method: "POST",
		body: formData,
	});
}

// fileExistsByHash checks whether the server already has a file with the
// given plaintext hash. The client calls this before uploading to skip the
// upload entirely when the file content is already stored.
export async function fileExistsByHash(
	token: string,
	hash: string,
): Promise<boolean> {
	const res = await request<{ exists: boolean }>(
		`/api/files/exists?hash=${encodeURIComponent(hash)}`,
		token,
	);

	return res.exists;
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
	fileHashes?: string[];
	opts?: EditMessageOptions;
	clearLocation?: boolean;
	threadId?: string;
	encrypted?: boolean;
	encryptedPayload?: string;
}

function buildEditBody(params: EditMessageParams): Record<string, unknown> {
	const body: Record<string, unknown> = { text: params.text };
	if (params.fileIDs !== undefined) body.fileIDs = params.fileIDs;
	if (params.fileHashes !== undefined) body.fileHashes = params.fileHashes;
	if (params.clearLocation) {
		body.clearLocation = true;
	}
	if (params.encrypted === true) {
		body.encrypted = true;
		body.encryptedPayload = params.encryptedPayload;
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
