import type { Message } from "../types/api.ts";

export interface MessageListEntry {
	type: "separator" | "message";
	msg: Message;
}

// Collects the ids of other users' messages in the visible range that
// have not been marked as read yet. Skipping already-read messages
// breaks the read-receipt feedback loop (POST → local markAsRead →
// notify → live query re-run → re-render → re-mark → POST again).
export function collectVisibleUnreadIds(
	entries: MessageListEntry[],
	startIndex: number,
	endIndex: number,
	userId: string,
): string[] {
	const out: string[] = [];

	for (let i = startIndex; i <= endIndex; i++) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		if (entry.msg.fromId === userId) continue;
		if (entry.msg.deliveryStatus === "read") continue;
		out.push(entry.msg.id);
	}

	return out;
}
