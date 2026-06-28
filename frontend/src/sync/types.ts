// Re-export the outbox op shapes from the schema module so the rest
// of the sync engine can depend on a single import location.
export type {
	OutboxOp,
	OutboxOpDelete,
	OutboxOpEdit,
	OutboxOpSend,
} from "../db/schema.ts";
