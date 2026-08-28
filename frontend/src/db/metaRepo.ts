import { getDB } from "./init.ts";
import { notify } from "./notify.ts";

const KEY_LAST_SYNCED_AT = "lastSyncedAt";

export const metaRepo = {
	async get(key: string): Promise<unknown> {
		const db = await getDB();
		const entry = await db.get("meta", key);
		return entry?.value;
	},

	async set(key: string, value: unknown): Promise<void> {
		const db = await getDB();
		await db.put("meta", { key, value });
		notify();
	},

	// setNoNotify updates meta without triggering live-query notifications.
	// Use for e2ee key updates to avoid unnecessary re-renders across all chats.
	async setNoNotify(key: string, value: unknown): Promise<void> {
		const db = await getDB();
		await db.put("meta", { key, value });
	},

	async getLastSyncedAt(): Promise<string | null> {
		const value = await this.get(KEY_LAST_SYNCED_AT);
		return typeof value === "string" ? value : null;
	},

	async setLastSyncedAt(value: string): Promise<void> {
		await this.set(KEY_LAST_SYNCED_AT, value);
	},
};
