import { getDB } from "./init.ts";
import { notify } from "./notify.ts";
import { pendingBlobsRepo } from "./pendingBlobsRepo.ts";
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

	// Queued operations of a deleted chat must not recreate its messages.
	async removeByChat(chatId: string): Promise<void> {
		const db = await getDB();
		const all = await db.getAll("outbox");
		const ops = all.filter((op) => op.chatId === chatId);
		if (ops.length === 0) return;

		const tx = db.transaction("outbox", "readwrite");
		await Promise.all(ops.map((op) => tx.store.delete(op.opId)));
		await tx.done;

		const blobIds = ops.flatMap((op) =>
			"pendingFileClientIds" in op ? op.pendingFileClientIds : [],
		);
		await pendingBlobsRepo.deleteMany(blobIds);
		notify();
	},

	async count(): Promise<number> {
		const db = await getDB();
		return db.count("outbox");
	},
};
