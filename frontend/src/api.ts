// The API client is a single flat module by design; splitting it would
// scatter the shared request/error handling.
/* eslint-disable max-lines */
import type {
	AppConfig,
	BlockedUser,
	CallInfo,
	Chat,
	CreateChatOptions,
	EditMessageOptions,
	FileInfo,
	ICEConfig,
	Message,
	ReactionSummary,
	SessionsResponse,
	SyncResponse,
	Thread,
	User,
	VerifyCodeResult,
} from "./types/api.ts";
import { emitUnauthorized, replacementToken } from "./utils/authEvents.ts";

const HTTP_UNAUTHORIZED = 401;
const KEY_BACKUP_ENDPOINT = "/api/users/key-backup";

// ApiError is the refusal of the server with the status the interface needs
// to tell a peer that is busy (409) from a request that is not allowed (403),
// and with the machine-readable reason when the status alone is not enough
// (the two sides of a busy call share the 409). The message keeps the
// `http <status>: ...` shape the rest of the code reads.
export class ApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(status: number, message: string, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

async function request<T>(
	path: string,
	token: string | undefined,
	init?: RequestInit,
	retryOnRotatedToken = true,
): Promise<T> {
	const headers: Record<string, string> = {};
	if (token !== undefined) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (!(init?.body instanceof FormData)) {
		headers["Content-Type"] = "application/json";
	}
	const headersInit = init?.headers;
	const initHeaders: Record<string, string> =
		headersInit instanceof Headers
			? Object.fromEntries(headersInit.entries())
			: Array.isArray(headersInit)
				? Object.fromEntries(new Headers(headersInit).entries())
				: { ...headersInit };
	const mergedHeaders = { ...initHeaders, ...headers };
	const res = await fetch(path, { ...init, headers: mergedHeaders });
	if (res.status === HTTP_UNAUTHORIZED) {
		const replacement =
			token === undefined ? undefined : replacementToken(token);
		if (
			retryOnRotatedToken &&
			token !== undefined &&
			replacement !== undefined &&
			replacement !== token
		) {
			// Another tab refreshed the same session while this request was
			// in flight. Retry once with the token it stored.
			return request(path, replacement, init, false);
		}
		if (token !== undefined) {
			emitUnauthorized(token);
		}
		throw new Error("unauthorized");
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as Record<string, string>;
		const retryAfter = res.headers.get("Retry-After");
		const suffix = retryAfter !== null ? ` retry-after:${retryAfter}` : "";
		throw new ApiError(
			res.status,
			`http ${res.status}: ${body.error ?? ""}${suffix}`,
			body.code,
		);
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

export interface DevicePayload {
	deviceId?: string;
	deviceName?: string;
}

export function verifyCode(
	email: string,
	code: string,
	device: DevicePayload = {},
) {
	return request<VerifyCodeResult>("/api/auth/verify-code", undefined, {
		method: "POST",
		body: JSON.stringify({ email, code, ...device }),
	});
}

export function completeRegistration(
	setupToken: string,
	nick: string,
	device: DevicePayload = {},
	displayName = nick,
) {
	return request<{
		user: User;
		token: string;
		expiresAt: string;
		sessionId?: string;
		deviceId?: string;
	}>("/api/auth/complete-registration", undefined, {
		method: "POST",
		body: JSON.stringify({
			setupToken,
			username: nick,
			displayName,
			...device,
		}),
	});
}

export function refreshToken(token: string) {
	return request<{ token: string; expiresAt: string; sessionId?: string }>(
		"/api/auth/refresh-token",
		token,
		{ method: "POST" },
	);
}

export function getSessions(token: string) {
	return request<SessionsResponse>("/api/sessions", token);
}

export function revokeDeviceSession(token: string, sessionId: string) {
	return request<{ status: string }>(
		`/api/sessions/${encodeURIComponent(sessionId)}`,
		token,
		{ method: "DELETE" },
	);
}

export function logoutAllSessions(token: string) {
	return request<{ status: string }>("/api/auth/logout-all", token, {
		method: "POST",
	});
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

export function getBlockedUsers(token: string) {
	return request<{ users: BlockedUser[] }>("/api/blocks", token);
}

export function blockUser(token: string, userId: string) {
	return request<{ users: BlockedUser[] }>(
		`/api/blocks/${encodeURIComponent(userId)}`,
		token,
		{ method: "POST" },
	);
}

export function unblockUser(token: string, userId: string) {
	return request<{ users: BlockedUser[] }>(
		`/api/blocks/${encodeURIComponent(userId)}`,
		token,
		{ method: "DELETE" },
	);
}

export function uploadUserAvatar(token: string, fileId: string) {
	return request<{ user: User }>("/api/users/avatar", token, {
		method: "POST",
		body: JSON.stringify({ fileId }),
	});
}

export function searchUsers(token: string, q: string) {
	return request<{ users: User[] }>(
		`/api/users/search?q=${encodeURIComponent(q)}`,
		token,
	);
}

export function pressBotCallback(
	token: string,
	chatId: string,
	messageId: string,
	data: string,
) {
	return request<{ ok: boolean; result: { callback_query_id: string } }>(
		`/api/bot-chats/${encodeURIComponent(chatId)}/callbacks`,
		token,
		{ method: "POST", body: JSON.stringify({ messageId, data }) },
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
	location?: { lat: number; lng: number };
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
			location: params.location,
		}),
	});
}

export function uploadPublicKey(
	token: string,
	publicKey: string,
	identityPublicKey: string,
	masterKeyVersion: number,
) {
	return request<{ status: string }>("/api/users/public-key", token, {
		method: "PUT",
		body: JSON.stringify({ publicKey, identityPublicKey, masterKeyVersion }),
	});
}

export function getPublicKey(token: string, userId: string) {
	return request<{
		publicKey: string;
		identityPublicKey: string;
		keyVersion?: string;
		masterKeyVersion: number;
	}>(`/api/users/${encodeURIComponent(userId)}/public-key`, token);
}

export function setKeyBackup(
	token: string,
	backup: string,
	masterKeyVersion: number,
) {
	return request<{ status: string }>(KEY_BACKUP_ENDPOINT, token, {
		method: "PUT",
		body: JSON.stringify({ backup, masterKeyVersion }),
	});
}

export function getKeyBackup(token: string) {
	return request<{ backup: string }>(KEY_BACKUP_ENDPOINT, token);
}

export function deleteKeyBackup(token: string, masterKeyVersion: number) {
	return request<{ status: string }>(
		`${KEY_BACKUP_ENDPOINT}?masterKeyVersion=${masterKeyVersion}`,
		token,
		{ method: "DELETE" },
	);
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

export function addMessageReaction(
	token: string,
	chatId: string,
	messageId: string,
	emoji: string,
) {
	return request<{ reactions: ReactionSummary[] }>(
		`/api/chats/${chatId}/messages/${messageId}/reactions`,
		token,
		{ method: "POST", body: JSON.stringify({ emoji }) },
	);
}

export function removeMessageReaction(
	token: string,
	chatId: string,
	messageId: string,
	emoji: string,
) {
	return request<{ reactions: ReactionSummary[] }>(
		`/api/chats/${chatId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
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

export function pinMessage(token: string, chatId: string, messageId: string) {
	return request<{ status: string }>(
		`/api/chats/${chatId}/pins/${messageId}`,
		token,
		{ method: "POST" },
	);
}

export function unpinMessage(token: string, chatId: string, messageId: string) {
	return request<{ status: string }>(
		`/api/chats/${chatId}/pins/${messageId}`,
		token,
		{ method: "DELETE" },
	);
}

export function getPinnedMessages(token: string, chatId: string) {
	return request<{ messages: Message[] }>(`/api/chats/${chatId}/pins`, token);
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

export function getSync(
	token: string,
	since: string,
	signal?: AbortSignal,
	limit?: number,
	sinceId?: string,
): Promise<SyncResponse> {
	const params = new URLSearchParams({ since });
	if (limit !== undefined) params.set("limit", String(limit));
	if (sinceId !== undefined && sinceId !== "") params.set("sinceId", sinceId);
	return request<SyncResponse>(`/api/sync?${params.toString()}`, token, {
		signal,
	});
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

export function startCall(token: string, chatId: string, offer: string) {
	return request<{
		callId: string;
		state: string;
		iceServers?: ICEConfig;
	}>("/api/calls", token, {
		method: "POST",
		body: JSON.stringify({ chatId, offer }),
	});
}

export function acceptCall(token: string, callId: string, answer: string) {
	return request<{
		callId: string;
		state: string;
		iceServers?: ICEConfig;
	}>(`/api/calls/${callId}/accept`, token, {
		method: "POST",
		body: JSON.stringify({ answer }),
	});
}

export function rejectCall(token: string, callId: string) {
	return request<{ status: string }>(`/api/calls/${callId}/reject`, token, {
		method: "POST",
	});
}

export function hangupCall(token: string, callId: string, reason?: string) {
	return request<{ status: string }>(`/api/calls/${callId}/hangup`, token, {
		method: "POST",
		body: JSON.stringify({ reason }),
	});
}

// hangupCallOnLeave ends the call when the page goes away. The request must
// survive the unload of the page, so it is sent with keepalive.
export function hangupCallOnLeave(token: string, callId: string) {
	return request<{ status: string }>(`/api/calls/${callId}/hangup`, token, {
		method: "POST",
		body: JSON.stringify({ reason: "peer-left" }),
		keepalive: true,
	}).catch(() => undefined);
}

// sendCallIce forwards an ICE candidate. The candidate travels as it comes
// from the browser: the other side hands it to its own connection.
export function sendCallIce(
	token: string,
	callId: string,
	candidate: RTCIceCandidateInit,
) {
	return request<{ status: string }>(`/api/calls/${callId}/ice`, token, {
		method: "POST",
		body: JSON.stringify({ candidate }),
	});
}

export function getCurrentCall(token: string) {
	return request<CallInfo>("/api/calls/current", token);
}

export function getIceServers(token: string) {
	return request<ICEConfig>("/api/ice", token);
}

export interface ManagedBot {
	id: string;
	username: string;
	displayName?: string;
	isActive: boolean;
	isMaster: boolean;
}

export function listBots(token: string) {
	return request<{ ok: boolean; result: ManagedBot[] }>("/api/bots", token);
}

export function createBot(
	token: string,
	username: string,
	displayName: string,
) {
	return request<{ ok: boolean; bot: ManagedBot; token: string }>(
		"/api/bots",
		token,
		{
			method: "POST",
			body: JSON.stringify({ username, displayName }),
		},
	);
}

export function rotateBotToken(token: string, username: string) {
	return request<{ ok: boolean; token: string }>(
		`/api/bots/${encodeURIComponent(username)}/token`,
		token,
		{ method: "POST" },
	);
}

// --- Administration -------------------------------------------------------

export interface AdminUser {
	id: string;
	username: string;
	email: string;
	displayName?: string;
	isBot: boolean;
	isAdmin: boolean;
	banned: boolean;
	online: boolean;
}

export interface AdminUserPage {
	users: AdminUser[];
	total: number;
	offset: number;
	limit: number;
}

export interface AdminChat {
	id: string;
	type: string;
	name: string;
	ownerId: string;
	botId?: string;
	createdAt: string;
	remoteServer?: string;
}

export interface AdminChatPage {
	chats: AdminChat[];
	total: number;
	offset: number;
	limit: number;
}

export interface AdminBot {
	id: string;
	username: string;
	displayName: string;
	ownerId: string;
	ownerUsername: string;
	encryptionMode: string;
	isActive: boolean;
	isMaster: boolean;
}

export interface AdminAuditEntry {
	id: string;
	actorId: string;
	action: string;
	targetType: string;
	targetId: string;
	detail?: string;
	createdAt: string;
}

function adminQuery(
	params: Record<string, string | number | undefined>,
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") search.set(key, String(value));
	}
	const encoded = search.toString();

	return encoded === "" ? "" : `?${encoded}`;
}

export function adminListUsers(
	token: string,
	query: string,
	offset: number,
): Promise<AdminUserPage> {
	return request<AdminUserPage>(
		`/api/admin/users${adminQuery({ query, limit: 50, offset })}`,
		token,
	);
}

export function adminPatchUser(
	token: string,
	userId: string,
	patch: { isAdmin?: boolean; banned?: boolean },
): Promise<{ status: string }> {
	return request<{ status: string }>(
		`/api/admin/users/${encodeURIComponent(userId)}`,
		token,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
}

export function adminListChats(
	token: string,
	query: string,
	offset: number,
): Promise<AdminChatPage> {
	return request<AdminChatPage>(
		`/api/admin/chats${adminQuery({ query, limit: 50, offset })}`,
		token,
	);
}

export function adminDeleteChat(
	token: string,
	chatId: string,
): Promise<{ status: string }> {
	return request<{ status: string }>(
		`/api/admin/chats/${encodeURIComponent(chatId)}`,
		token,
		{ method: "DELETE" },
	);
}

export function adminListMessages(
	token: string,
	chatId: string,
	before?: string,
): Promise<{ messages: Message[]; nextCursor?: string; hasMore: boolean }> {
	return request(
		`/api/admin/chats/${encodeURIComponent(chatId)}/messages${adminQuery({ limit: 50, before })}`,
		token,
	);
}

export function adminDeleteMessage(
	token: string,
	chatId: string,
	messageId: string,
): Promise<{ status: string }> {
	return request<{ status: string }>(
		`/api/admin/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
		token,
		{ method: "DELETE" },
	);
}

export function adminListBots(token: string): Promise<{ bots: AdminBot[] }> {
	return request<{ bots: AdminBot[] }>("/api/admin/bots", token);
}

export function adminPatchBot(
	token: string,
	botId: string,
	isActive: boolean,
): Promise<{ status: string }> {
	return request<{ status: string }>(
		`/api/admin/bots/${encodeURIComponent(botId)}`,
		token,
		{ method: "PATCH", body: JSON.stringify({ isActive }) },
	);
}

export function adminListFederationPeers(
	token: string,
): Promise<{ peers: string[] }> {
	return request<{ peers: string[] }>("/api/admin/federation/peers", token);
}

export function adminListAudit(
	token: string,
): Promise<{ entries: AdminAuditEntry[] }> {
	return request<{ entries: AdminAuditEntry[] }>(
		"/api/admin/audit?limit=100",
		token,
	);
}
