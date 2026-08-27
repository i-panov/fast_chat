import type { DBSchema } from "idb";
import type {
	Chat,
	FileInfo,
	Location,
	MessageDeliveryStatus,
	MessageStatus,
	ReplyToInfo,
	Thread,
} from "../types/api.ts";

export interface StoredChat extends Chat {
	_updatedAt: string;
}

export interface StoredMessage {
	id: string;
	chatId: string;
	fromId: string;
	fromNick: string;
	text: string;
	encrypted?: boolean;
	encryptedPayload?: string;
	createdAt: string;
	editedAt?: string;
	replyTo?: ReplyToInfo;
	files?: FileInfo[];
	location?: Location;
	status: MessageStatus | "deleted";
	deliveryStatus?: MessageDeliveryStatus;
	readBy?: string[];
	_updatedAt: string;
}

export interface StoredThread extends Thread {
	_updatedAt: string;
}

export interface StoredThreadMessage {
	id: string;
	threadId: string;
	chatId: string;
	fromId: string;
	fromNick: string;
	text: string;
	encrypted?: boolean;
	encryptedPayload?: string;
	createdAt: string;
	editedAt?: string;
	replyTo?: ReplyToInfo;
	files?: FileInfo[];
	location?: Location;
	status: MessageStatus | "deleted";
	deliveryStatus?: MessageDeliveryStatus;
	readBy?: string[];
	_updatedAt: string;
}

export interface OutboxOpSend {
	kind: "send";
	opId: string;
	status?: "pending" | "failed";
	chatId: string;
	msgId: string;
	text: string;
	encrypted?: boolean;
	encryptedPayload?: string;
	replyToId?: string;
	pendingFileClientIds: string[];
	location?: { lat: number; lng: number };
	createdAt: string;
	attempts: number;
	threadId?: string;
}

export interface OutboxOpEdit {
	kind: "edit";
	opId: string;
	status?: "pending" | "failed";
	chatId: string;
	messageId: string;
	text: string;
	encrypted?: boolean;
	encryptedPayload?: string;
	pendingFileClientIds: string[];
	keptFileIds: string[];
	filesToRemove: string[];
	location?: { lat: number; lng: number } | null;
	clearLocation?: boolean;
	clientEditedAt: string;
	createdAt: string;
	attempts: number;
	threadId?: string;
}

export interface OutboxOpDelete {
	kind: "delete";
	opId: string;
	status?: "pending" | "failed";
	chatId: string;
	messageId: string;
	createdAt: string;
	attempts: number;
	threadId?: string;
}

export type OutboxOp = OutboxOpSend | OutboxOpEdit | OutboxOpDelete;

export interface PendingBlob {
	id: string;
	blob: Blob;
	name: string;
	mimeType: string;
	size: number;
}

export interface CachedFile {
	url: string;
	blob: Blob;
	mimeType: string;
	cachedAt: number;
	size: number;
}

export interface MetaEntry {
	key: string;
	value: unknown;
}

export const DB_NAME = "fast_chat";
export const DB_VERSION = 3;

export interface FCSchema extends DBSchema {
	chats: {
		key: string;
		value: StoredChat;
		indexes: { _updatedAt: string };
	};
	messages: {
		key: string;
		value: StoredMessage;
		indexes: { chatId: string; _updatedAt: string; status: string };
	};
	threads: {
		key: string;
		value: StoredThread;
		indexes: { chatId: string; _updatedAt: string };
	};
	threadMessages: {
		key: string;
		value: StoredThreadMessage;
		indexes: { threadId: string; chatId: string; _updatedAt: string };
	};
	outbox: {
		key: string;
		value: OutboxOp;
		indexes: { createdAt: string };
	};
	pendingBlobs: {
		key: string;
		value: PendingBlob;
	};
	fileCache: {
		key: string;
		value: CachedFile;
		indexes: { cachedAt: number };
	};
	meta: {
		key: string;
		value: MetaEntry;
	};
}
