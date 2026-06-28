import { getDB } from "./init.ts";
import { notify } from "./notify.ts";

const KEY_LAST_SYNCED_AT = "lastSyncedAt";

export const metaRepo = {
	async getLastSyncedAt(): Promise<string | null> {
		const db = await getDB();
		const entry = await db.get("meta", KEY_LAST_SYNCED_AT);
		return typeof entry?.value === "string" ? entry.value : null;
	},

	async setLastSyncedAt(value: string): Promise<void> {
		const db = await getDB();
		await db.put("meta", { key: KEY_LAST_SYNCED_AT, value });
		notify();
	},
};
