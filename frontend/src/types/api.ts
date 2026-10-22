import type { FileKey } from "../e2ee/file-crypto.ts";

export interface User {
	id: string;
	nick: string;
	email?: string;
	online: boolean;
}

export interface MemberInfo {
	id: string;
	nick: string;
	online?: boolean;
}

export interface Chat {
	id: string;
	type: "private" | "group" | "self";
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
	// hash is the SHA-256 hex digest of the plaintext file content. Used to
	// look up decryption keys (keys are indexed by hash, not file ID).
	hash?: string;
}

export interface PendingFile {
	id: string;
	file: File;
	blobUrl: string;
	originalName: string;
	size: number;
	mimeType: string;
	fileType: "photo" | "video" | "audio" | "file";
	// encrypted defaults to true. For large files the user may opt out of
	// encryption (faster upload, less CPU). When false, the file is uploaded
	// as-is and the server deduplicates by its own content hash.
	encrypted?: boolean;
}

// LargeFileThreshold is the size above which the UI should ask the user
// whether to encrypt the file. Encrypting very large files is CPU-intensive
// and slow, so for media like movies/games the user may prefer to send them
// unencrypted.
export const LargeFileThreshold = 500 * 1024 * 1024; // 500 MiB

export type MessageStatus = "sent" | "queued" | "failed";

export type MessageDeliveryStatus = "sent" | "delivered" | "read";

export interface Message {
	id: string;
	chatId: string;
	// threadId is set on the messages of a thread. The chat of such a
	// message is the real chat, so the thread is what says where the
	// message belongs.
	threadId?: string;
	fromId: string;
	fromNick: string;
	text: string;
	encrypted?: boolean;
	encryptedPayload?: string;
	// Set when the client could not decrypt this message (missing key,
	// changed key, or envelope mismatch). The UI renders it distinctly.
	undecryptable?: boolean;
	// fileKeys maps file ID to its decryption key for encrypted files.
	// Populated during decryption. Absent for plaintext messages.
	fileKeys?: Record<string, FileKey>;
	createdAt: string;
	editedAt?: string;
	replyTo?: ReplyToInfo;
	files?: FileInfo[];
	location?: Location;
	status?: MessageStatus;
	deliveryStatus?: MessageDeliveryStatus;
	readBy?: string[];
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
	version?: string;
	commit?: string;
}

interface VerifyCodeExisting {
	isNew: false;
	user: User;
	token: string;
	expiresAt: string;
}

interface VerifyCodeNew {
	isNew: true;
	setupToken: string;
}

export type VerifyCodeResult = VerifyCodeExisting | VerifyCodeNew;

export type CreateChatOptions =
	| { type: "private"; withUserId: string }
	| { type: "group"; name: string; memberIds: string[] };

export interface EditMessageOptions {
	clearLocation?: boolean;
}

export interface TypingPayload {
	chatId: string;
	userId: string;
	nick: string;
}

interface SyncDeletedMessage {
	chatId: string;
	messageId: string;
	deletedAt: string;
}

interface SyncDeletedChat {
	chatId: string;
	deletedAt: string;
}

// CallState is the state of a call: it rings, it is answered, or it is over.
type CallState = "ringing" | "active" | "ended";

// CallRole tells which side of a call the user is on. The two sides report
// the end of a call differently.
export type CallRole = "caller" | "callee";

// CallInfo is the call of the user: the one it is in, or the last one.
export interface CallInfo {
	callId: string;
	peer: string;
	state: CallState;
	role: CallRole;
	reason?: string;
	endedAt?: string;
	offer?: string;
	answer?: string;
}

// ICEConfig lists the servers a browser may use to reach its peer. The TURN
// credentials reach every authorized client, so the configuration is only
// served to them.
export interface ICEConfig {
	stun: string[];
	turn: { urls: string[]; username: string; credential: string }[];
}

export interface SyncResponse {
	serverNow: string;
	chats: Chat[];
	deletedChats: SyncDeletedChat[];
	messages: Message[];
	// threadMessages are the messages of the threads of the chats. They are
	// delivered apart from the chat messages: they live in their own store.
	threadMessages?: Message[];
	deletedMessages: SyncDeletedMessage[];
	onlineStatus?: Record<string, boolean>;
}
