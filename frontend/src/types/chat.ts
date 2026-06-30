import type { FileInfo, Location } from "../api.ts";

export interface EditingMessage {
	chatId: string;
	messageId: string;
	text: string;
	files?: FileInfo[];
	threadId?: string;
	location?: Location | null;
}

export interface ReplyTarget {
	chatId: string;
	messageId: string;
	fromNick: string;
	text: string;
	files?: FileInfo[];
}
