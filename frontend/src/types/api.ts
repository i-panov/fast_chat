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

export type MessageDeliveryStatus = "sent" | "delivered" | "read";

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
	deliveryStatus?: MessageDeliveryStatus;
	readBy?: string[];
}

export interface MessageReadStatus {
	messageId: string;
	userId: string;
	status: "delivered" | "read";
	readAt: string;
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

export interface VerifyCodeExisting {
	isNew: false;
	user: User;
	token: string;
	expiresAt: string;
}

export interface VerifyCodeNew {
	isNew: true;
	setupToken: string;
}

export type VerifyCodeResult = VerifyCodeExisting | VerifyCodeNew;

export type CreateChatOptions =
	| { type: "private"; withUserId: string }
	| { type: "group"; name: string; memberIds: string[] };

export interface EditMessageOptions {
	location?: Location | null;
	clearLocation?: boolean;
}

export interface TypingPayload {
	chatId: string;
	userId: string;
	nick: string;
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
	onlineStatus?: Record<string, boolean>;
}
