import { getDB } from "./init.ts";
import { notify } from "./notify.ts";
import type { OutboxOp } from "./schema.ts";

export const outboxRepo = {
	async list(): Promise<OutboxOp[]> {
		const db = await getDB();
		const all = await db.getAll("outbox");
		return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	},

	async enqueue(op: OutboxOp): Promise<void> {
		const db = await getDB();
		await db.put("outbox", op);
		notify();
	},

	async remove(opId: string): Promise<void> {
		const db = await getDB();
		await db.delete("outbox", opId);
		notify();
	},

	async update(op: OutboxOp): Promise<void> {
		const db = await getDB();
		await db.put("outbox", op);
		notify();
	},

	async count(): Promise<number> {
		const db = await getDB();
		return db.count("outbox");
	},
};
