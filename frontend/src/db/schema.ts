import type { DBSchema } from "idb";
import type { Chat, FileInfo, Location, ReplyToInfo } from "../api.ts";

export type MessageStatus = "sent" | "queued" | "failed";

export interface StoredChat extends Chat {
	_updatedAt: string;
}

export interface StoredMessage {
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
	status: MessageStatus | "deleted";
	_updatedAt: string;
}

export interface OutboxOpSend {
	kind: "send";
	opId: string;
	status?: "pending" | "failed";
	chatId: string;
	msgId: string;
	text: string;
	replyToId?: string;
	pendingFileClientIds: string[];
	location?: { lat: number; lng: number };
	createdAt: string;
	attempts: number;
}

export interface OutboxOpEdit {
	kind: "edit";
	opId: string;
	status?: "pending" | "failed";
	chatId: string;
	messageId: string;
	text: string;
	pendingFileClientIds: string[];
	keptFileIds: string[];
	filesToRemove: string[];
	location?: { lat: number; lng: number } | null;
	clearLocation?: boolean;
	clientEditedAt: string;
	createdAt: string;
	attempts: number;
}

export interface OutboxOpDelete {
	kind: "delete";
	opId: string;
	status?: "pending" | "failed";
	chatId: string;
	messageId: string;
	createdAt: string;
	attempts: number;
}

export type OutboxOp = OutboxOpSend | OutboxOpEdit | OutboxOpDelete;

export interface PendingBlob {
	id: string;
	blob: Blob;
	name: string;
	mimeType: string;
	size: number;
}

export interface MetaEntry {
	key: string;
	value: unknown;
}

export const DB_NAME = "fast_chat";
export const DB_VERSION = 1;

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
	outbox: {
		key: string;
		value: OutboxOp;
		indexes: { createdAt: string };
	};
	pendingBlobs: {
		key: string;
		value: PendingBlob;
	};
	meta: {
		key: string;
		value: MetaEntry;
	};
}
